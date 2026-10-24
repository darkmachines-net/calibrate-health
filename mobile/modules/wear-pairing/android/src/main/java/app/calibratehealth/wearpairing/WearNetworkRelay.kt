/** Phone-side bounded network relay restricted to the retained watch, account, and server binding. */

package app.calibratehealth.wearpairing

import android.content.Context
import com.google.android.gms.tasks.Tasks
import com.google.android.gms.wearable.Wearable
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

internal object WearNetworkRelayPolicy {
    const val PAIRING_EXCHANGE_PATH = "/auth/mobile/wear/pair"
    const val SESSION_REFRESH_PATH = "/auth/mobile/refresh"
    const val WATCH_SNAPSHOT_PATH = "/api/v1/watch"
    const val WATCH_MUTATION_PATH = "/api/v1/watch/mutations"
    const val OUTCOME_UNKNOWN_ERROR_CODE = "PHONE_REQUEST_OUTCOME_UNKNOWN"

    private val allowedHeaders = setOf(
        "authorization",
        "if-none-match",
        "x-calibrate-client-platform",
        "x-calibrate-client-version",
        "x-client-operation-id"
    )

    fun supports(method: String, path: String): Boolean = when (path) {
        WATCH_SNAPSHOT_PATH -> method == "GET"
        PAIRING_EXCHANGE_PATH, SESSION_REFRESH_PATH, WATCH_MUTATION_PATH -> method == "POST"
        else -> false
    }

    fun supportsHeader(name: String): Boolean = name.lowercase() in allowedHeaders

    fun hasValidHeaders(path: String, headers: Map<String, String>): Boolean = runCatching {
        require(headers.keys.all(::supportsHeader))
        require(headers.keys.map { it.lowercase() }.toSet().size == headers.size)
        fun header(name: String): String? = headers.entries
            .firstOrNull { it.key.equals(name, ignoreCase = true) }
            ?.value
        fun hasBearerToken(): Boolean = header("Authorization")
            ?.let { it.startsWith("Bearer ") && it.length > "Bearer ".length }
            ?: false
        require(header("X-Calibrate-Client-Platform") == "wear_os")
        require(header("X-Calibrate-Client-Version")?.matches(CLIENT_VERSION_PATTERN) == true)
        when (path) {
            WATCH_SNAPSHOT_PATH -> {
                require(hasBearerToken())
                require(header("X-Client-Operation-Id") == null)
            }
            WATCH_MUTATION_PATH -> {
                require(hasBearerToken())
                require(header("If-None-Match") == null)
                require(header("X-Client-Operation-Id")?.matches(OPERATION_ID_PATTERN) == true)
            }
            else -> {
                require(header("Authorization") == null)
                require(header("If-None-Match") == null)
                require(header("X-Client-Operation-Id") == null)
            }
        }
    }.isSuccess

    private val CLIENT_VERSION_PATTERN = Regex("^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$")
    private val OPERATION_ID_PATTERN = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$")
}

private data class WearNetworkRelayRequest(
    val requestId: String,
    val serverOrigin: String,
    val method: String,
    val path: String,
    val headers: Map<String, String>,
    val body: String?
)

/** Retains only successful refresh rotations long enough to recover a lost Data Layer response. */
internal class WearRefreshRelayResponseCache(
    private val nowEpochMs: () -> Long = System::currentTimeMillis
) {
    private data class Entry(
        val nodeId: String,
        val serverOrigin: String,
        val payload: String,
        val expiresAtEpochMs: Long
    )

    private val entries = linkedMapOf<String, Entry>()

    @Synchronized
    fun find(requestId: String, nodeId: String, serverOrigin: String): String? {
        removeExpired()
        val entry = entries[requestId] ?: return null
        return entry.payload.takeIf { entry.nodeId == nodeId && entry.serverOrigin == serverOrigin }
    }

    @Synchronized
    fun retain(requestId: String, nodeId: String, serverOrigin: String, payload: String) {
        removeExpired()
        entries[requestId] = Entry(
            nodeId = nodeId,
            serverOrigin = serverOrigin,
            payload = payload,
            expiresAtEpochMs = nowEpochMs() + RETENTION_MS
        )
        while (entries.size > MAX_ENTRIES) entries.remove(entries.keys.first())
    }

    private fun removeExpired() {
        val now = nowEpochMs()
        entries.entries.removeAll { (_, entry) -> entry.expiresAtEpochMs <= now }
    }

    private companion object {
        const val RETENTION_MS = 10 * 60 * 1_000L
        const val MAX_ENTRIES = 8
    }
}

/** Executes a bounded, allowlisted Watch request on the paired phone's network. */
internal object WearNetworkRelay {
    private val refreshResponseCache = WearRefreshRelayResponseCache()
    private val executor = ThreadPoolExecutor(
        1,
        1,
        30,
        TimeUnit.SECONDS,
        ArrayBlockingQueue(8),
        { runnable -> Thread(runnable, "calibrate-phone-wear-relay").apply { isDaemon = true } },
        ThreadPoolExecutor.AbortPolicy()
    ).apply { allowCoreThreadTimeOut(true) }

    fun dispatch(context: Context, nodeId: String, payload: ByteArray) {
        if (payload.size > MAX_RELAY_MESSAGE_BYTES || nodeId.isBlank() || nodeId.length > 256) return
        try {
            executor.execute { process(context.applicationContext, nodeId, payload) }
        } catch (_: RejectedExecutionException) {
            // The watch retains its operation and will retry through WorkManager.
        }
    }

    private fun process(context: Context, nodeId: String, payload: ByteArray) {
        val request = parseRequest(payload) ?: return
        val bindingStore = WearNetworkRelayBindingStore(context)
        val response = if (!bindingStore.isAuthorized(nodeId, request.serverOrigin, request.path)) {
            failure(request.requestId, request.serverOrigin, "RELAY_NOT_AUTHORIZED", "Pair Calibrate with this phone again.")
        } else {
            val retainedRefresh = if (request.path == WearNetworkRelayPolicy.SESSION_REFRESH_PATH) {
                refreshResponseCache.find(request.requestId, nodeId, request.serverOrigin)
            } else {
                null
            }
            retainedRefresh
                ?: runCatching { execute(request) }.getOrElse {
                    failure(
                        request.requestId,
                        request.serverOrigin,
                        if (request.path == WearNetworkRelayPolicy.SESSION_REFRESH_PATH) {
                            WearNetworkRelayPolicy.OUTCOME_UNKNOWN_ERROR_CODE
                        } else {
                            "PHONE_NETWORK_UNAVAILABLE"
                        },
                        if (request.path == WearNetworkRelayPolicy.SESSION_REFRESH_PATH) {
                            "The phone could not confirm whether session refresh completed."
                        } else {
                            "The paired phone could not reach the Calibrate server."
                        }
                    )
                }
        }
        val bytes = response.toByteArray(Charsets.UTF_8)
        if (bytes.size > MAX_RELAY_MESSAGE_BYTES) return
        if (request.path == WearNetworkRelayPolicy.SESSION_REFRESH_PATH && isSuccessfulResponse(response)) {
            refreshResponseCache.retain(request.requestId, nodeId, request.serverOrigin, response)
        }
        runCatching {
            Tasks.await(
                Wearable.getMessageClient(context).sendMessage(nodeId, WearPairingProtocol.NETWORK_RESPONSE, bytes),
                MESSAGE_TIMEOUT_SECONDS,
                TimeUnit.SECONDS
            )
        }
    }

    private fun isSuccessfulResponse(payload: String): Boolean = runCatching {
        val response = JSONObject(payload)
        response.getBoolean("ok") && response.getInt("status") in 200..299
    }.getOrDefault(false)

    private fun parseRequest(payload: ByteArray): WearNetworkRelayRequest? = runCatching {
        val value = JSONObject(payload.toString(Charsets.UTF_8))
        val expectedKeys = setOf(
            "kind", "protocol_version", "request_id", "server_origin", "method", "path", "headers", "body"
        )
        require(value.keys().asSequence().toSet() == expectedKeys)
        require(value.getString("kind") == "watch_http_request")
        require(value.getInt("protocol_version") == 1)
        val requestId = value.getString("request_id").requiredText(128)
        val serverOrigin = value.getString("server_origin").requiredText(2_048)
        val method = value.getString("method")
        val path = value.getString("path")
        require(WearNetworkRelayPolicy.supports(method, path))
        val headersValue = value.getJSONObject("headers")
        val headers = linkedMapOf<String, String>()
        val normalizedHeaderNames = mutableSetOf<String>()
        for (name in headersValue.keys()) {
            require(WearNetworkRelayPolicy.supportsHeader(name))
            require(normalizedHeaderNames.add(name.lowercase()))
            val headerValue = headersValue.getString(name).requiredText(MAX_HEADER_VALUE_LENGTH)
            require('\r' !in headerValue && '\n' !in headerValue)
            require(headers.put(name, headerValue) == null)
        }
        require(WearNetworkRelayPolicy.hasValidHeaders(path, headers))
        val body = if (value.isNull("body")) null else value.getString("body")
        require((body?.toByteArray(Charsets.UTF_8)?.size ?: 0) <= MAX_RELAY_BODY_BYTES)
        require((method == "GET") == (body == null))
        WearNetworkRelayRequest(requestId, serverOrigin, method, path, headers, body)
    }.getOrNull()

    private fun execute(request: WearNetworkRelayRequest): String {
        val connection = URL(request.serverOrigin + request.path).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = request.method
            connection.connectTimeout = CONNECT_TIMEOUT_MS
            connection.readTimeout = READ_TIMEOUT_MS
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.setRequestProperty("Accept", "application/json")
            request.headers.forEach { (name, value) -> connection.setRequestProperty(name, value) }
            request.body?.let { body ->
                val bytes = body.toByteArray(Charsets.UTF_8)
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                connection.setFixedLengthStreamingMode(bytes.size)
                connection.outputStream.use { it.write(bytes) }
            }
            val status = connection.responseCode
            val stream = if (status >= 400) connection.errorStream else connection.inputStream
            val body = stream?.use(::readBounded)?.toString(Charsets.UTF_8).orEmpty()
            val headers = JSONObject()
            RESPONSE_HEADERS.forEach { name ->
                connection.getHeaderField(name)?.takeIf { it.length <= MAX_HEADER_VALUE_LENGTH }?.let {
                    headers.put(name, it)
                }
            }
            return JSONObject()
                .put("kind", "phone_http_response")
                .put("protocol_version", 1)
                .put("request_id", request.requestId)
                .put("server_origin", request.serverOrigin)
                .put("ok", true)
                .put("status", status)
                .put("headers", headers)
                .put("body", body)
                .toString()
        } finally {
            connection.disconnect()
        }
    }

    private fun failure(requestId: String, serverOrigin: String, code: String, message: String): String = JSONObject()
        .put("kind", "phone_http_response")
        .put("protocol_version", 1)
        .put("request_id", requestId)
        .put("server_origin", serverOrigin)
        .put("ok", false)
        .put("error_code", code)
        .put("message", message)
        .toString()

    private fun readBounded(stream: java.io.InputStream): ByteArray {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(8 * 1024)
        while (true) {
            val count = stream.read(buffer)
            if (count < 0) break
            require(output.size() + count <= MAX_RELAY_BODY_BYTES) { "Relayed response is too large." }
            output.write(buffer, 0, count)
        }
        return output.toByteArray()
    }

    private fun String.requiredText(maximumLength: Int): String {
        val trimmed = trim()
        require(trimmed.isNotEmpty() && trimmed.length <= maximumLength)
        return trimmed
    }

    private const val MAX_RELAY_MESSAGE_BYTES = 64 * 1024
    private const val MAX_RELAY_BODY_BYTES = 48 * 1024
    private const val MAX_HEADER_VALUE_LENGTH = 1_024
    private const val CONNECT_TIMEOUT_MS = 8_000
    private const val READ_TIMEOUT_MS = 12_000
    private const val MESSAGE_TIMEOUT_SECONDS = 8L
    private val RESPONSE_HEADERS = listOf(
        "Content-Type",
        "ETag",
        "X-Calibrate-Minimum-Client-Version"
    )
}
