/** Bounded direct HTTP exchange of one-time pairing credentials for a watch-scoped session. */

package app.calibratehealth.wear.pairing

import app.calibratehealth.wear.data.security.SecureSession
import app.calibratehealth.wear.network.WearClientCompatibility
import app.calibratehealth.wear.network.UrlConnectionWatchHttpTransport
import app.calibratehealth.wear.network.JsonValue
import app.calibratehealth.wear.network.StrictJson
import app.calibratehealth.wear.network.WatchHttpRequest
import app.calibratehealth.wear.network.WatchHttpTransport
import app.calibratehealth.wear.network.requireObject
import app.calibratehealth.wear.network.requiredLong
import app.calibratehealth.wear.network.requiredObject
import app.calibratehealth.wear.network.requiredString
import java.io.IOException
import java.time.Instant

internal data class PairingExchangeRequest(
    val pairingToken: String,
    val serverOrigin: String,
    val watchDeviceId: String,
    val exchangeId: String,
    val challengeSignature: String
)

internal open class PairingExchangeException(message: String) : IllegalStateException(message)
internal class WearUpgradeRequiredException(message: String) : PairingExchangeException(message)

/** Exchanges once, with one identical transport retry so the backend can revoke a response-lost session. */
internal class WearPairingHttpClient(
    private val transport: WatchHttpTransport = UrlConnectionWatchHttpTransport(),
    private val maxTransportAttempts: Int = 2
) {
    suspend fun exchange(request: PairingExchangeRequest): SecureSession {
        require(maxTransportAttempts in 1..2) { "Pairing transport attempts must be one or two." }
        val url = buildPairingExchangeUrl(request.serverOrigin)
        val requestBytes = StrictJson.stringify(
            StrictJson.objectOf(
                "pairing_token" to StrictJson.string(request.pairingToken),
                "server_origin" to StrictJson.string(request.serverOrigin),
                "watch_device_id" to StrictJson.string(request.watchDeviceId),
                "protocol_version" to StrictJson.number(WEAR_PAIRING_PROTOCOL_VERSION),
                "exchange_id" to StrictJson.string(request.exchangeId),
                "challenge_signature" to StrictJson.string(request.challengeSignature)
            )
        )
            .toByteArray(Charsets.UTF_8)
        require(requestBytes.size <= MAX_PAIRING_MESSAGE_BYTES) { "Pairing exchange payload is too large." }

        repeat(maxTransportAttempts) { attempt ->
            try {
                return exchangeOnce(url, requestBytes, request.serverOrigin, request.watchDeviceId)
            } catch (error: PairingExchangeException) {
                // An HTTP response or invalid response body must never be retried.
                throw error
            } catch (error: IOException) {
                if (attempt == maxTransportAttempts - 1) {
                    throw PairingExchangeException("Pairing response was unavailable. Start pairing again.")
                }
                // Retry identical signed material once. If the server consumed the first request,
                // its PAIRING_RESPONSE_LOST response revokes the possibly orphaned session.
            }
        }
        throw PairingExchangeException("Pairing response was unavailable. Start pairing again.")
    }

    private suspend fun exchangeOnce(
        url: String,
        requestBytes: ByteArray,
        serverOrigin: String,
        watchDeviceId: String
    ): SecureSession {
        val response = transport.execute(
            WatchHttpRequest(
                method = "POST",
                url = url,
                headers = WearClientCompatibility.headers(),
                body = requestBytes.toString(Charsets.UTF_8)
            )
        )
        val status = response.status
        val body = response.body
        WearClientCompatibility.parseUpgradeRequired(
            status,
            body,
            response.header(WearClientCompatibility.MINIMUM_VERSION_HEADER)
        )?.let { throw WearUpgradeRequiredException(it.message) }
        val contentType = response.header("Content-Type").orEmpty().lowercase()
        if (contentType.isNotEmpty() && !contentType.startsWith("application/json")) {
            throw PairingExchangeException("Pairing server returned an unsupported response.")
        }
        if (status != 200) {
            val errorCode = runCatching {
                (StrictJson.parse(body).requireObject().values["code"] as? JsonValue.StringValue)?.value
            }.getOrNull()
                ?.takeIf { it.matches(Regex("[A-Z0-9_]{1,64}")) }
            throw PairingExchangeException(
                when (errorCode) {
                    "PAIRING_RESPONSE_LOST" -> "The pairing response was lost and revoked. Start pairing again."
                    "PAIRING_CREDENTIAL_EXPIRED" -> "The pairing request expired. Start pairing again."
                    else -> "Pairing was rejected by the server. Start pairing again."
                }
            )
        }
        return parseSession(body, serverOrigin, watchDeviceId)
    }

    private fun parseSession(body: String, serverOrigin: String, watchDeviceId: String): SecureSession {
        val json = runCatching { StrictJson.parse(body).requireObject() }.getOrElse {
            throw PairingExchangeException("Pairing server returned invalid JSON.")
        }
        val user = runCatching { json.requiredObject("user") }.getOrNull()
            ?: throw PairingExchangeException("Pairing response omitted the account.")
        val accessToken = runCatching { json.requiredString("access_token") }.getOrNull()
            ?.takeIf { it.isNotBlank() && it.length <= 512 }
            ?: throw PairingExchangeException("Pairing response omitted the access token.")
        val refreshToken = runCatching { json.requiredString("refresh_token") }.getOrNull()
            ?.takeIf { it.isNotBlank() && it.length <= 512 }
            ?: throw PairingExchangeException("Pairing response omitted the refresh token.")
        val userId = runCatching { user.requiredLong("id") }.getOrNull()?.takeIf { it > 0 }
            ?: throw PairingExchangeException("Pairing response contained an invalid account.")
        val accessExpiry = runCatching { json.requiredString("access_expires_at") }.getOrNull().toEpochMillis()
            ?: throw PairingExchangeException("Pairing response contained an invalid access expiry.")
        val refreshExpiry = runCatching { json.requiredString("refresh_expires_at") }.getOrNull().toEpochMillis()
            ?: throw PairingExchangeException("Pairing response contained an invalid refresh expiry.")
        if (accessExpiry <= System.currentTimeMillis() || refreshExpiry < accessExpiry) {
            throw PairingExchangeException("Pairing response contained invalid expiries.")
        }
        return SecureSession(
            accessToken = accessToken,
            refreshToken = refreshToken,
            userId = userId,
            serverOrigin = serverOrigin,
            watchDeviceId = watchDeviceId,
            accessExpiresAtEpochMs = accessExpiry,
            refreshExpiresAtEpochMs = refreshExpiry
        )
    }

    private fun String?.toEpochMillis(): Long? {
        val value = this ?: return null
        return runCatching { Instant.parse(value).toEpochMilli() }.getOrNull()?.takeIf { it > 0 }
    }

}
