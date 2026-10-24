/** Versioned pairing message validation, identity binding, and bounded serialization. */

package app.calibratehealth.wear.pairing

import app.calibratehealth.wear.data.security.ServerOriginPolicy
import app.calibratehealth.wear.network.StrictJson
import org.json.JSONObject
import java.net.URI
import java.time.Instant

internal const val WEAR_PAIRING_PROTOCOL_VERSION = 1
internal const val PAIR_HELLO_PATH = "/calibrate/v1/pair/hello"
internal const val PAIR_CREDENTIAL_PATH = "/calibrate/v1/pair/credential"
internal const val PAIR_RESULT_PATH = "/calibrate/v1/pair/result"
internal const val ACCOUNT_DISCONNECT_PATH = "/calibrate/v1/account/disconnect"
internal const val ACCOUNT_DISCONNECT_RESULT_PATH = "/calibrate/v1/account/disconnect-result"
internal const val MAX_PAIRING_MESSAGE_BYTES = 32 * 1024
internal const val MAX_PAIRING_WINDOW_MS = 5 * 60 * 1000L
private const val MAX_CLOCK_SKEW_MS = 30 * 1000L
private const val PAIRING_EXCHANGE_PATH = "/auth/mobile/wear/pair"

internal data class PhonePairingInvite(
    val requestId: String,
    val serverOrigin: String,
    val issuedAtEpochMs: Long,
    val expiresAtEpochMs: Long
)

internal data class WearPairingCredential(
    val requestId: String,
    val pairingToken: String,
    val serverOrigin: String,
    val watchDeviceId: String,
    val challenge: String,
    val expiresAtEpochMs: Long
)

internal data class PendingPairingInvite(
    val requestId: String,
    val phoneNodeId: String,
    val serverOrigin: String,
    val expiresAtEpochMs: Long,
    val watchDeviceId: String,
    val watchDeviceName: String,
    val keyAlias: String
)

internal data class PendingPairingResult(
    val requestId: String,
    val phoneNodeId: String,
    val serverOrigin: String,
    val expiresAtEpochMs: Long,
    val watchDeviceId: String,
    val payload: String
)

internal data class PhoneAccountDisconnect(
    val requestId: String,
    val serverOrigin: String,
    val userId: Long,
    val watchDeviceId: String,
    val issuedAtEpochMs: Long
)

internal data class PairingFields(
    val kind: String? = null,
    val requestId: String? = null,
    val protocolVersion: Int? = null,
    val serverOrigin: String? = null,
    val issuedAt: String? = null,
    val expiresAt: String? = null,
    val pairingToken: String? = null,
    val watchDeviceId: String? = null,
    val challenge: String? = null,
    val userId: Long? = null,
    val issuedAtEpochMs: Long? = null
)

/** Accept deletion only from the exact phone node and server account retained during pairing. */
internal fun parsePhoneAccountDisconnect(
    fields: PairingFields,
    sourceNodeId: String,
    expectedNodeId: String,
    expectedServerOrigin: String,
    expectedUserId: Long,
    expectedWatchDeviceId: String,
    nowEpochMs: Long
): PhoneAccountDisconnect? {
    if (fields.kind != "phone_account_deleted" || fields.protocolVersion != WEAR_PAIRING_PROTOCOL_VERSION) return null
    val requestId = fields.requestId.requiredText(128) ?: return null
    val origin = fields.serverOrigin.requiredText(2_048) ?: return null
    val watchDeviceId = fields.watchDeviceId.requiredText(128) ?: return null
    val userId = fields.userId ?: return null
    val issuedAtEpochMs = fields.issuedAtEpochMs ?: return null
    if (
        sourceNodeId != expectedNodeId || origin != expectedServerOrigin ||
        userId != expectedUserId || watchDeviceId != expectedWatchDeviceId
    ) return null
    if (issuedAtEpochMs > nowEpochMs + MAX_CLOCK_SKEW_MS) return null
    if (issuedAtEpochMs < nowEpochMs - MAX_PAIRING_WINDOW_MS) return null
    return PhoneAccountDisconnect(requestId, origin, userId, watchDeviceId, issuedAtEpochMs)
}

/** Positive ACK is emitted only after WearLocalDisconnect reports complete watch-local cleanup. */
internal fun buildAccountDisconnectResult(command: PhoneAccountDisconnect): String = StrictJson.stringify(
    StrictJson.objectOf(
        "kind" to StrictJson.string("watch_account_disconnected"),
        "request_id" to StrictJson.string(command.requestId),
        "protocol_version" to StrictJson.number(WEAR_PAIRING_PROTOCOL_VERSION),
        "server_origin" to StrictJson.string(command.serverOrigin),
        "user_id" to StrictJson.number(command.userId),
        "watch_device_id" to StrictJson.string(command.watchDeviceId),
        "ok" to StrictJson.boolean(true)
    )
)

/** Report both successful and failed exchanges so the phone can retire the consumed one-time request. */
internal fun buildPairingResult(pending: PendingPairingInvite, errorMessage: String? = null): String {
    val values = linkedMapOf(
        "ok" to StrictJson.boolean(errorMessage == null),
        "request_id" to StrictJson.string(pending.requestId),
        "protocol_version" to StrictJson.number(WEAR_PAIRING_PROTOCOL_VERSION),
        "server_origin" to StrictJson.string(pending.serverOrigin),
        "watch_device_id" to StrictJson.string(pending.watchDeviceId)
    )
    if (errorMessage == null) {
        values["watch_device_name"] = StrictJson.string(pending.watchDeviceName)
    } else {
        values["message"] = StrictJson.string(
            errorMessage.trim().take(180).ifEmpty { "Pairing failed. Start pairing again on your phone." }
        )
    }
    return StrictJson.stringify(StrictJson.objectOf(*values.toList().toTypedArray()))
}

internal fun parsePhonePairingInvite(
    fields: PairingFields,
    expectedServerOrigin: String,
    nowEpochMs: Long
): PhonePairingInvite? {
    if (fields.kind != "phone_pairing_invite" || fields.protocolVersion != WEAR_PAIRING_PROTOCOL_VERSION) return null
    val requestId = fields.requestId.requiredText(128) ?: return null
    val origin = fields.serverOrigin.requiredText(2_048) ?: return null
    if (origin != expectedServerOrigin || runCatching { requireOriginOnly(origin) }.isFailure) return null
    val issuedAt = fields.issuedAt.parseInstantMillis() ?: return null
    val expiresAt = fields.expiresAt.parseInstantMillis() ?: return null
    if (issuedAt > nowEpochMs + MAX_CLOCK_SKEW_MS) return null
    if (expiresAt <= nowEpochMs || expiresAt <= issuedAt) return null
    if (expiresAt - issuedAt > MAX_PAIRING_WINDOW_MS + MAX_CLOCK_SKEW_MS) return null
    return PhonePairingInvite(requestId, origin, issuedAt, expiresAt)
}

internal fun parseWearPairingCredential(
    fields: PairingFields,
    pending: PendingPairingInvite,
    sourceNodeId: String,
    nowEpochMs: Long
): WearPairingCredential? {
    if (fields.protocolVersion != WEAR_PAIRING_PROTOCOL_VERSION) return null
    val requestId = fields.requestId.requiredText(128) ?: return null
    val token = fields.pairingToken.requiredText(256) ?: return null
    val origin = fields.serverOrigin.requiredText(2_048) ?: return null
    val deviceId = fields.watchDeviceId.requiredText(128) ?: return null
    val challenge = fields.challenge.requiredText(512) ?: return null
    val expiresAt = fields.expiresAt.parseInstantMillis() ?: return null
    if (
        requestId != pending.requestId || sourceNodeId != pending.phoneNodeId ||
        origin != pending.serverOrigin || deviceId != pending.watchDeviceId
    ) return null
    if (expiresAt <= nowEpochMs || expiresAt - nowEpochMs > MAX_PAIRING_WINDOW_MS + MAX_CLOCK_SKEW_MS) return null
    return WearPairingCredential(requestId, token, origin, deviceId, challenge, expiresAt)
}

internal fun isCorrelated(pending: PendingPairingInvite, requestId: String, nodeId: String, origin: String): Boolean =
    pending.requestId == requestId && pending.phoneNodeId == nodeId && pending.serverOrigin == origin

/** Exact UTF-8 payload verified by the backend with SHA-256/ECDSA. */
internal fun buildPairingSigningPayload(
    serverOrigin: String,
    watchDeviceId: String,
    exchangeId: String,
    challenge: String
): ByteArray = "calibrate-wear-pairing-v1\n$serverOrigin\n$watchDeviceId\n$exchangeId\n$challenge"
    .toByteArray(Charsets.UTF_8)

internal fun buildPairingExchangeUrl(serverOrigin: String): String =
    requireOriginOnly(serverOrigin) + PAIRING_EXCHANGE_PATH

private fun requireOriginOnly(value: String): String {
    ServerOriginPolicy.requireSafeOrigin(value)
    val uri = URI(value)
    require(uri.isAbsolute && (uri.scheme == "https" || uri.scheme == "http"))
    require(!uri.host.isNullOrBlank() && uri.userInfo == null && uri.query == null && uri.fragment == null)
    require(uri.rawPath.isNullOrEmpty() || uri.rawPath == "/")
    require(uri.port == -1 || uri.port in 1..65_535)
    return "${uri.scheme}://${uri.rawAuthority}"
}

private fun String?.requiredText(maxLength: Int): String? =
    this?.trim()?.takeIf { it.isNotEmpty() && it.length <= maxLength }

private fun String?.parseInstantMillis(): Long? =
    this?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }

internal fun JSONObject.toPairingFields(): PairingFields = PairingFields(
    kind = optStringOrNull("kind"),
    requestId = optStringOrNull("request_id"),
    protocolVersion = (opt("protocol_version") as? Number)?.let { number ->
        number.toInt().takeIf { number.toDouble() == it.toDouble() }
    },
    serverOrigin = optStringOrNull("server_origin"),
    issuedAt = optStringOrNull("issued_at"),
    expiresAt = optStringOrNull("expires_at"),
    pairingToken = optStringOrNull("pairing_token"),
    watchDeviceId = optStringOrNull("watch_device_id"),
    challenge = optStringOrNull("challenge"),
    userId = optExactLongOrNull("user_id"),
    issuedAtEpochMs = optExactLongOrNull("issued_at_epoch_ms")
)

private fun JSONObject.optStringOrNull(key: String): String? =
    opt(key) as? String

private fun JSONObject.optExactLongOrNull(key: String): Long? =
    (opt(key) as? Number)?.let { number ->
        number.toLong().takeIf { number.toDouble() == it.toDouble() }
    }
