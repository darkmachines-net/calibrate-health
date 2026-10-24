/** Bounded authenticated phone relay with direct-network fallback for watch API requests. */

package app.calibratehealth.wear.network

import android.content.Context
import app.calibratehealth.wear.WearDataLayerContract
import app.calibratehealth.wear.data.security.AndroidKeystoreTokenStore
import app.calibratehealth.wear.pairing.TrustedPhoneBindingStore
import com.google.android.gms.tasks.Tasks
import com.google.android.gms.wearable.Wearable
import java.io.IOException
import java.net.URI
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

internal data class PhoneRelayTarget(
    val nodeId: String,
    val serverOrigin: String
)

internal fun interface PhoneRelayTargetResolver {
    fun resolve(serverOrigin: String): PhoneRelayTarget?
}

internal fun interface PhoneRelayMessenger {
    suspend fun exchange(target: PhoneRelayTarget, requestId: String, payload: String): String
}

/** Uses the trusted phone's native background service as the primary HTTP route for Wear. */
internal class PhoneRelayWatchHttpTransport(
    private val targetResolver: PhoneRelayTargetResolver,
    private val messenger: PhoneRelayMessenger
) : WatchHttpTransport {
    override suspend fun execute(request: WatchHttpRequest): WatchHttpResponse {
        val endpoint = relayEndpoint(request.url)
        require(PhoneRelayContract.supports(request.method, endpoint.path)) {
            "Watch request is not eligible for phone relay."
        }
        val target = targetResolver.resolve(endpoint.serverOrigin)
            ?: throw IOException("The paired phone relay is unavailable.")
        require(target.serverOrigin == endpoint.serverOrigin) { "Phone relay origin changed." }
        val requestId = relayRequestId(endpoint, request)
        val payload = buildRelayRequest(requestId, endpoint, request)
        if (payload.toByteArray(Charsets.UTF_8).size > PhoneRelayContract.MAX_MESSAGE_BYTES) {
            throw IOException("Watch request is too large for the paired phone relay.")
        }
        val response = messenger.exchange(target, requestId, payload)
        return parseRelayResponse(response, requestId, endpoint.serverOrigin, endpoint.path)
    }

    private fun relayRequestId(endpoint: RelayEndpoint, request: WatchHttpRequest): String {
        if (endpoint.path != PhoneRelayContract.SESSION_REFRESH_PATH) return UUID.randomUUID().toString()
        val digest = MessageDigest.getInstance("SHA-256").digest(
            StrictJson.stringify(
                StrictJson.objectOf(
                    "server_origin" to StrictJson.string(endpoint.serverOrigin),
                    "method" to StrictJson.string(request.method),
                    "path" to StrictJson.string(endpoint.path),
                    "body" to StrictJson.string(request.body.orEmpty())
                )
            ).toByteArray(Charsets.UTF_8)
        )
        return "refresh-${digest.joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }}"
    }

    private fun buildRelayRequest(
        requestId: String,
        endpoint: RelayEndpoint,
        request: WatchHttpRequest
    ): String {
        val headers = JsonValue.Object(request.headers.mapValues { StrictJson.string(it.value) })
        return StrictJson.stringify(
            StrictJson.objectOf(
                "kind" to StrictJson.string("watch_http_request"),
                "protocol_version" to StrictJson.number(1),
                "request_id" to StrictJson.string(requestId),
                "server_origin" to StrictJson.string(endpoint.serverOrigin),
                "method" to StrictJson.string(request.method),
                "path" to StrictJson.string(endpoint.path),
                "headers" to headers,
                "body" to (request.body?.let(StrictJson::string) ?: JsonValue.Null)
            )
        )
    }

    private fun parseRelayResponse(
        payload: String,
        expectedRequestId: String,
        expectedServerOrigin: String,
        expectedPath: String
    ): WatchHttpResponse {
        val root = StrictJson.parse(payload).requireObject("phone relay response")
        require(root.requiredString("kind") == "phone_http_response")
        require(root.requiredLong("protocol_version") == 1L)
        require(root.requiredString("request_id") == expectedRequestId)
        require(root.requiredString("server_origin") == expectedServerOrigin)
        if (!root.requiredBoolean("ok")) {
            val errorCode = root.requiredString("error_code")
            val message = root.requiredString("message").take(180)
            val refreshOutcomeUnknown = expectedPath == PhoneRelayContract.SESSION_REFRESH_PATH &&
                errorCode == PhoneRelayContract.NETWORK_UNAVAILABLE_ERROR_CODE
            if (errorCode == PhoneRelayContract.OUTCOME_UNKNOWN_ERROR_CODE || refreshOutcomeUnknown) {
                throw PhoneRelayOutcomeUnknownException(
                    message.ifBlank { "The paired phone may have completed the Watch request." }
                )
            }
            throw IOException(message.ifBlank { "The paired phone could not relay the Watch request." })
        }
        val status = root.requiredLong("status").toInt()
        require(status in 100..599) { "Phone relay returned an invalid HTTP status." }
        val headers = root.requiredObject("headers").values.mapValues { (_, value) ->
            (value as? JsonValue.StringValue)?.value
                ?: throw InvalidJsonException("Relayed HTTP headers must be strings.")
        }
        val body = root.requiredString("body")
        require(body.toByteArray(Charsets.UTF_8).size <= PhoneRelayContract.MAX_BODY_BYTES) {
            "Phone relay response is too large."
        }
        return WatchHttpResponse(status, headers, body)
    }

    private data class RelayEndpoint(val serverOrigin: String, val path: String)

    private fun relayEndpoint(url: String): RelayEndpoint {
        val uri = URI(url)
        require(uri.isAbsolute && (uri.scheme == "https" || uri.scheme == "http"))
        require(!uri.host.isNullOrBlank() && uri.userInfo == null && uri.query == null && uri.fragment == null)
        require(uri.port == -1 || uri.port in 1..65_535)
        val path = uri.rawPath ?: ""
        val origin = "${uri.scheme}://${uri.rawAuthority}"
        return RelayEndpoint(origin, path)
    }
}

/** Retains direct HTTP only as bounded mixed-version failover while phone and watch upgrades roll out. */
internal class PhoneFirstWatchHttpTransport(
    private val phoneRelay: WatchHttpTransport,
    private val directFallback: WatchHttpTransport = UrlConnectionWatchHttpTransport()
) : WatchHttpTransport {
    override suspend fun execute(request: WatchHttpRequest): WatchHttpResponse = try {
        phoneRelay.execute(request)
    } catch (error: PhoneRelayOutcomeUnknownException) {
        throw error
    } catch (_: IOException) {
        directFallback.execute(request)
    }
}

internal class PhoneRelayOutcomeUnknownException(message: String) : IOException(message)

internal object PhoneRelayContract {
    const val PAIRING_EXCHANGE_PATH = "/auth/mobile/wear/pair"
    const val SESSION_REFRESH_PATH = "/auth/mobile/refresh"
    const val WATCH_SNAPSHOT_PATH = "/api/v1/watch"
    const val WATCH_MUTATION_PATH = "/api/v1/watch/mutations"
    const val MAX_MESSAGE_BYTES = 64 * 1024
    const val MAX_BODY_BYTES = 48 * 1024
    const val OUTCOME_UNKNOWN_ERROR_CODE = "PHONE_REQUEST_OUTCOME_UNKNOWN"
    const val NETWORK_UNAVAILABLE_ERROR_CODE = "PHONE_NETWORK_UNAVAILABLE"

    fun supports(method: String, path: String): Boolean = when (path) {
        WATCH_SNAPSHOT_PATH -> method == "GET"
        PAIRING_EXCHANGE_PATH, SESSION_REFRESH_PATH, WATCH_MUTATION_PATH -> method == "POST"
        else -> false
    }
}

internal object PhoneRelayResponseInbox {
    private data class Entry(val nodeId: String, val payload: String)
    private val responses = linkedMapOf<String, Entry>()

    @Synchronized
    fun append(nodeId: String, bytes: ByteArray) {
        if (bytes.size > PhoneRelayContract.MAX_MESSAGE_BYTES) return
        val payload = bytes.toString(Charsets.UTF_8)
        val requestId = runCatching {
            StrictJson.parse(payload).requireObject("phone relay response").requiredString("request_id")
        }.getOrNull()?.takeIf { it.isNotBlank() && it.length <= 128 } ?: return
        responses[requestId] = Entry(nodeId, payload)
        while (responses.size > MAX_RESPONSES) responses.remove(responses.keys.first())
    }

    @Synchronized
    fun consume(requestId: String, nodeId: String): String? {
        val entry = responses[requestId] ?: return null
        if (entry.nodeId != nodeId) return null
        responses.remove(requestId)
        return entry.payload
    }

    private const val MAX_RESPONSES = 16
}

internal class GooglePlayPhoneRelayMessenger(private val context: Context) : PhoneRelayMessenger {
    override suspend fun exchange(target: PhoneRelayTarget, requestId: String, payload: String): String =
        withContext(Dispatchers.IO) {
            PhoneRelayResponseInbox.consume(requestId, target.nodeId)?.let { return@withContext it }
            val bytes = payload.toByteArray(Charsets.UTF_8)
            try {
                Tasks.await(
                    Wearable.getMessageClient(context.applicationContext).sendMessage(
                        target.nodeId,
                        WearDataLayerContract.NETWORK_REQUEST,
                        bytes
                    ),
                    MESSAGE_SEND_TIMEOUT_SECONDS,
                    TimeUnit.SECONDS
                )
            } catch (error: TimeoutException) {
                throw PhoneRelayOutcomeUnknownException(
                    "The paired phone may have received the Watch request."
                )
            } catch (error: Exception) {
                throw IOException("The paired phone could not receive the Watch request.", error)
            }
            val deadline = System.currentTimeMillis() + RESPONSE_TIMEOUT_MS
            while (System.currentTimeMillis() < deadline) {
                PhoneRelayResponseInbox.consume(requestId, target.nodeId)?.let { return@withContext it }
                delay(POLL_INTERVAL_MS)
            }
            throw PhoneRelayOutcomeUnknownException("The paired phone did not return the Watch request.")
        }

    private companion object {
        const val MESSAGE_SEND_TIMEOUT_SECONDS = 8L
        // Covers the phone's bounded connect, read, and response-delivery windows before direct failover.
        const val RESPONSE_TIMEOUT_MS = 32_000L
        const val POLL_INTERVAL_MS = 50L
    }
}

internal fun pairedPhoneFirstHttpTransport(context: Context): WatchHttpTransport {
    val appContext = context.applicationContext
    val relay = PhoneRelayWatchHttpTransport(
        targetResolver = PhoneRelayTargetResolver { serverOrigin ->
            val session = runCatching { AndroidKeystoreTokenStore(appContext).read() }.getOrNull()
                ?: return@PhoneRelayTargetResolver null
            val binding = TrustedPhoneBindingStore(appContext).read(session)
                ?: return@PhoneRelayTargetResolver null
            PhoneRelayTarget(binding.nodeId, binding.serverOrigin).takeIf { it.serverOrigin == serverOrigin }
        },
        messenger = GooglePlayPhoneRelayMessenger(appContext)
    )
    return PhoneFirstWatchHttpTransport(relay)
}

internal fun pairingPhoneFirstHttpTransport(
    context: Context,
    phoneNodeId: String,
    serverOrigin: String
): WatchHttpTransport {
    val target = PhoneRelayTarget(phoneNodeId, serverOrigin)
    val relay = PhoneRelayWatchHttpTransport(
        targetResolver = PhoneRelayTargetResolver { requestedOrigin -> target.takeIf { it.serverOrigin == requestedOrigin } },
        messenger = GooglePlayPhoneRelayMessenger(context.applicationContext)
    )
    return PhoneFirstWatchHttpTransport(relay)
}
