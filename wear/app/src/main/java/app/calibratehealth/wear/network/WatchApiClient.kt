/** Bounded watch HTTP transport, access-token refresh, account-scoped rotation, and one-time authorization replay. */

package app.calibratehealth.wear.network

import app.calibratehealth.wear.data.security.AccountSessionCoordinator
import app.calibratehealth.wear.data.security.SecureSession
import app.calibratehealth.wear.data.security.SecureTokenStore
import app.calibratehealth.wear.data.security.accountScope
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

data class WatchHttpRequest(
    val method: String,
    val url: String,
    val headers: Map<String, String> = emptyMap(),
    val body: String? = null
)

data class WatchHttpResponse(
    val status: Int,
    val headers: Map<String, String>,
    val body: String
) {
    /** Finds a response header using case-insensitive HTTP header-name matching. */
    fun header(name: String): String? = headers.entries
        .firstOrNull { it.key.equals(name, ignoreCase = true) }
        ?.value
}

fun interface WatchHttpTransport {
    /** Executes one bounded HTTP request and returns status, headers, and body. */
    suspend fun execute(request: WatchHttpRequest): WatchHttpResponse
}

object WatchNetworkPolicy {
    const val CONNECT_TIMEOUT_MS = 8_000
    const val READ_TIMEOUT_MS = 12_000
    const val MAX_RESPONSE_BYTES = 128 * 1024
    const val ACCESS_REFRESH_SKEW_MS = 60_000L
}

/** HttpURLConnection transport with bounded waits and response bodies for unattended worker use. */
class UrlConnectionWatchHttpTransport : WatchHttpTransport {
    override suspend fun execute(request: WatchHttpRequest): WatchHttpResponse = withContext(Dispatchers.IO) {
        val connection = URL(request.url).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = request.method
            connection.connectTimeout = WatchNetworkPolicy.CONNECT_TIMEOUT_MS
            connection.readTimeout = WatchNetworkPolicy.READ_TIMEOUT_MS
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.setRequestProperty("Accept", "application/json")
            request.headers.forEach { (name, value) -> connection.setRequestProperty(name, value) }
            request.body?.let { body ->
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            val stream = if (status >= 400) connection.errorStream else connection.inputStream
            val responseBody = stream?.use { input ->
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(8 * 1024)
                var total = 0
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    total += count
                    if (total > WatchNetworkPolicy.MAX_RESPONSE_BYTES) {
                        throw IOException("Watch API response exceeded ${WatchNetworkPolicy.MAX_RESPONSE_BYTES} bytes.")
                    }
                    output.write(buffer, 0, count)
                }
                output.toString(Charsets.UTF_8.name())
            }.orEmpty()
            val headers = linkedMapOf<String, String>()
            connection.headerFields.forEach { (name, values) ->
                if (name != null && values != null) headers[name] = values.joinToString(",")
            }
            WatchHttpResponse(status, headers, responseBody)
        } finally {
            connection.disconnect()
        }
    }
}

sealed interface AuthenticatedApiResult {
    data class Response(val value: WatchHttpResponse) : AuthenticatedApiResult
    data class RetryableFailure(val message: String) : AuthenticatedApiResult
    data class AuthenticationRequired(val message: String) : AuthenticatedApiResult
    data class AccountChanged(val message: String = "The paired account changed during sync.") : AuthenticatedApiResult
    data class InvalidResponse(val message: String) : AuthenticatedApiResult
    data class UpgradeRequired(val message: String, val minimumVersion: String?) : AuthenticatedApiResult
}

fun interface WatchSnapshotApi {
    /** Fetches the authenticated watch snapshot with optional conditional ETag semantics. */
    suspend fun getSnapshot(session: SecureSession, etag: String?): AuthenticatedApiResult
}

fun interface WatchMutationApi {
    /** Submits an authenticated mutation under its stable operation identifier. */
    suspend fun postMutation(
        session: SecureSession,
        operationId: String,
        mutationType: String,
        payloadJson: String
    ): AuthenticatedApiResult
}

/** Owns access-token freshness, one-time 401 replay, and refresh-token rotation. */
class AuthenticatedWatchApi(
    private val tokenStore: SecureTokenStore,
    private val sessionCoordinator: AccountSessionCoordinator,
    private val transport: WatchHttpTransport,
    private val nowEpochMs: () -> Long = System::currentTimeMillis,
    clientVersion: String = app.calibratehealth.wear.BuildConfig.VERSION_NAME
) : WatchSnapshotApi, WatchMutationApi {
    private val clientHeaders = WearClientCompatibility.headers(clientVersion)
    override suspend fun getSnapshot(session: SecureSession, etag: String?): AuthenticatedApiResult = authenticatedRequest(
        capturedSession = session,
        method = "GET",
        path = "/api/v1/watch",
        headers = etag?.let { mapOf("If-None-Match" to it) }.orEmpty()
    )

    override suspend fun postMutation(
        session: SecureSession,
        operationId: String,
        mutationType: String,
        payloadJson: String
    ): AuthenticatedApiResult {
        require(OPERATION_ID_PATTERN.matches(operationId)) { "Invalid operation ID." }
        require(MUTATION_TYPE_PATTERN.matches(mutationType)) { "Invalid mutation type." }
        val payload = StrictJson.parse(payloadJson).requireObject("mutation payload")
        val body = StrictJson.stringify(
            StrictJson.objectOf(
                "type" to StrictJson.string(mutationType),
                "payload" to payload
            )
        )
        return authenticatedRequest(
            capturedSession = session,
            method = "POST",
            path = "/api/v1/watch/mutations",
            headers = mapOf("X-Client-Operation-Id" to operationId),
            body = body
        )
    }

    private suspend fun authenticatedRequest(
        capturedSession: SecureSession,
        method: String,
        path: String,
        headers: Map<String, String>,
        body: String? = null
    ): AuthenticatedApiResult {
        val currentAtStart = try {
            tokenStore.read()
        } catch (error: Exception) {
            return AuthenticatedApiResult.AuthenticationRequired(error.message ?: "Stored session is unavailable.")
        } ?: return AuthenticatedApiResult.AccountChanged()
        if (currentAtStart.accountScope() != capturedSession.accountScope()) {
            return AuthenticatedApiResult.AccountChanged()
        }
        // From this point, the request remains bound to the captured credential even if an account
        // swap begins concurrently. The final worker commit rechecks the scope under the account lock.
        var session = capturedSession

        if (session.refreshExpiresAtEpochMs <= nowEpochMs()) {
            return AuthenticatedApiResult.AuthenticationRequired("The watch session expired; pair again.")
        }
        if (session.accessExpiresAtEpochMs <= nowEpochMs() + WatchNetworkPolicy.ACCESS_REFRESH_SKEW_MS) {
            session = when (val refreshed = refresh(session, force = false)) {
                is SessionRefreshResult.Success -> refreshed.session
                is SessionRefreshResult.Retryable -> return AuthenticatedApiResult.RetryableFailure(refreshed.message)
                is SessionRefreshResult.AuthenticationRequired -> return AuthenticatedApiResult.AuthenticationRequired(refreshed.message)
                is SessionRefreshResult.AccountChanged -> return AuthenticatedApiResult.AccountChanged(refreshed.message)
                is SessionRefreshResult.InvalidResponse -> return AuthenticatedApiResult.InvalidResponse(refreshed.message)
                is SessionRefreshResult.UpgradeRequired -> return AuthenticatedApiResult.UpgradeRequired(
                    refreshed.message,
                    refreshed.minimumVersion
                )
            }
        }

        val first = executeAuthenticated(session, method, path, headers, body)
        if (first !is AuthenticatedApiResult.Response || first.value.status != 401) return first

        session = when (val refreshed = refresh(session, force = true)) {
            is SessionRefreshResult.Success -> refreshed.session
            is SessionRefreshResult.Retryable -> return AuthenticatedApiResult.RetryableFailure(refreshed.message)
            is SessionRefreshResult.AuthenticationRequired -> return AuthenticatedApiResult.AuthenticationRequired(refreshed.message)
            is SessionRefreshResult.AccountChanged -> return AuthenticatedApiResult.AccountChanged(refreshed.message)
            is SessionRefreshResult.InvalidResponse -> return AuthenticatedApiResult.InvalidResponse(refreshed.message)
            is SessionRefreshResult.UpgradeRequired -> return AuthenticatedApiResult.UpgradeRequired(
                refreshed.message,
                refreshed.minimumVersion
            )
        }
        val replay = executeAuthenticated(session, method, path, headers, body)
        return if (replay is AuthenticatedApiResult.Response && replay.value.status == 401) {
            AuthenticatedApiResult.AuthenticationRequired("The watch session is no longer valid; pair again.")
        } else {
            replay
        }
    }

    private suspend fun executeAuthenticated(
        session: SecureSession,
        method: String,
        path: String,
        headers: Map<String, String>,
        body: String?
    ): AuthenticatedApiResult = try {
        val response = transport.execute(
                WatchHttpRequest(
                    method = method,
                    url = endpointUrl(session.serverOrigin, path),
                    headers = headers + clientHeaders + ("Authorization" to "Bearer ${session.accessToken}"),
                    body = body
                )
            )
        val upgrade = WearClientCompatibility.parseUpgradeRequired(
            response.status,
            response.body,
            response.header(WearClientCompatibility.MINIMUM_VERSION_HEADER)
        )
        if (upgrade != null) {
            AuthenticatedApiResult.UpgradeRequired(upgrade.message, upgrade.minimumVersion)
        } else {
            AuthenticatedApiResult.Response(response)
        }
    } catch (error: IOException) {
        AuthenticatedApiResult.RetryableFailure(error.message ?: "Watch API network request failed.")
    } catch (error: Exception) {
        AuthenticatedApiResult.InvalidResponse(error.message ?: "Unable to construct Watch API request.")
    }

    private suspend fun refresh(rejected: SecureSession, force: Boolean): SessionRefreshResult = sharedRefreshMutex.withLock {
        val current = try {
            tokenStore.read()
        } catch (error: Exception) {
            return@withLock SessionRefreshResult.AuthenticationRequired(error.message ?: "Stored session is unavailable.")
        } ?: return@withLock SessionRefreshResult.AuthenticationRequired("Pair the watch before syncing.")

        val sameAccount = current.accountScope() == rejected.accountScope()
        if (!sameAccount) return@withLock SessionRefreshResult.AccountChanged()
        if (current.accessToken != rejected.accessToken) return@withLock SessionRefreshResult.Success(current)
        if (!force && current.accessExpiresAtEpochMs > nowEpochMs() + WatchNetworkPolicy.ACCESS_REFRESH_SKEW_MS) {
            return@withLock SessionRefreshResult.Success(current)
        }
        if (current.refreshExpiresAtEpochMs <= nowEpochMs()) {
            return@withLock SessionRefreshResult.AuthenticationRequired("The watch session expired; pair again.")
        }

        val requestBody = StrictJson.stringify(
            StrictJson.objectOf("refresh_token" to StrictJson.string(current.refreshToken))
        )
        val response = try {
            transport.execute(
                WatchHttpRequest(
                    method = "POST",
                    url = endpointUrl(current.serverOrigin, "/auth/mobile/refresh"),
                    headers = clientHeaders,
                    body = requestBody
                )
            )
        } catch (error: IOException) {
            return@withLock SessionRefreshResult.Retryable(error.message ?: "Session refresh failed.")
        } catch (error: Exception) {
            return@withLock SessionRefreshResult.InvalidResponse(error.message ?: "Unable to construct refresh request.")
        }

        WearClientCompatibility.parseUpgradeRequired(
            response.status,
            response.body,
            response.header(WearClientCompatibility.MINIMUM_VERSION_HEADER)
        )?.let {
            return@withLock SessionRefreshResult.UpgradeRequired(it.message, it.minimumVersion)
        }

        when {
            response.status in 500..599 || response.status == 408 || response.status == 425 || response.status == 429 ->
                return@withLock SessionRefreshResult.Retryable("Session refresh returned HTTP ${response.status}.")
            response.status == 400 || response.status == 401 || response.status == 403 ->
                return@withLock SessionRefreshResult.AuthenticationRequired("The watch session is no longer valid; pair again.")
            response.status !in 200..299 ->
                return@withLock SessionRefreshResult.InvalidResponse("Unexpected session refresh HTTP ${response.status}.")
        }

        val rotated = try {
            parseRotatedSession(response.body, current)
        } catch (error: Exception) {
            return@withLock SessionRefreshResult.InvalidResponse(error.message ?: "Invalid session refresh response.")
        }
        if (!sessionCoordinator.replaceIfScopeCurrent(rejected.accountScope(), rotated)) {
            return@withLock SessionRefreshResult.AccountChanged()
        }
        SessionRefreshResult.Success(rotated)
    }

    companion object {
        // Workers build independent API objects; one process-wide lock preserves refresh-token rotation order.
        private val sharedRefreshMutex = Mutex()
        private val OPERATION_ID_PATTERN = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$")
        private val MUTATION_TYPE_PATTERN = Regex("^[a-z_]+\\.[a-z_]+$")

        /** Joins a validated server origin with a fixed absolute API path, rejecting authority and query injection. */
        fun endpointUrl(serverOrigin: String, path: String): String {
            require(path.startsWith('/') && !path.startsWith("//") && '?' !in path && '#' !in path) {
                "Watch API path must be an absolute fixed path."
            }
            return serverOrigin.removeSuffix("/") + path
        }

        internal fun parseRotatedSession(body: String, previous: SecureSession): SecureSession {
            val root = StrictJson.parse(body).requireObject()
            val user = root.requiredObject("user")
            val userId = user.requiredLong("id")
            require(userId == previous.userId) { "Refresh response account does not match the paired account." }
            val accessExpiry = parseInstant(root.requiredString("access_expires_at"), "access_expires_at")
            val refreshExpiry = parseInstant(root.requiredString("refresh_expires_at"), "refresh_expires_at")
            return previous.copy(
                accessToken = root.requiredString("access_token").also { require(it.isNotBlank()) },
                refreshToken = root.requiredString("refresh_token").also { require(it.isNotBlank()) },
                accessExpiresAtEpochMs = accessExpiry,
                refreshExpiresAtEpochMs = refreshExpiry
            )
        }

        private fun parseInstant(value: String, field: String): Long = try {
            Instant.parse(value).toEpochMilli()
        } catch (error: Exception) {
            throw InvalidJsonException("$field must be an ISO-8601 instant.")
        }
    }
}

private sealed interface SessionRefreshResult {
    data class Success(val session: SecureSession) : SessionRefreshResult
    data class Retryable(val message: String) : SessionRefreshResult
    data class AuthenticationRequired(val message: String) : SessionRefreshResult
    data class AccountChanged(val message: String = "The paired account changed during sync.") : SessionRefreshResult
    data class InvalidResponse(val message: String) : SessionRefreshResult
    data class UpgradeRequired(val message: String, val minimumVersion: String?) : SessionRefreshResult
}
