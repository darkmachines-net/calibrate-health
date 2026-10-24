/** Regression tests and fixtures for Watch Api Client. */

package app.calibratehealth.wear.network

import app.calibratehealth.wear.data.security.AccountDataStore
import app.calibratehealth.wear.data.security.AccountSessionCoordinator
import app.calibratehealth.wear.data.security.SecureSession
import app.calibratehealth.wear.data.security.SecureTokenStore
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WatchApiClientTest {
    /** Verifies that fixed endpoint url rejects query and authority replacement. */
    @Test
    fun `fixed endpoint URL rejects query and authority replacement`() {
        assertEquals(
            "https://health.example.com/api/v1/watch",
            AuthenticatedWatchApi.endpointUrl("https://health.example.com", "/api/v1/watch")
        )
        assertTrue(runCatching {
            AuthenticatedWatchApi.endpointUrl("https://health.example.com", "//attacker.example/path")
        }.isFailure)
        assertTrue(runCatching {
            AuthenticatedWatchApi.endpointUrl("https://health.example.com", "/api/v1/watch?redirect=true")
        }.isFailure)
    }

    /** Verifies that mutation request carries stable operation id and wraps payload once. */
    @Test
    fun `mutation request carries stable operation id and wraps payload once`() = runBlocking {
        val store = MemoryTokenStore(session())
        var captured: WatchHttpRequest? = null
        val api = AuthenticatedWatchApi(
            tokenStore = store,
            sessionCoordinator = coordinator(store),
            transport = WatchHttpTransport { request ->
                captured = request
                WatchHttpResponse(200, emptyMap(), "{}")
            },
            nowEpochMs = { 1_000L },
            clientVersion = "0.1.0-internal"
        )

        val result = api.postMutation(
            session = store.value!!,
            operationId = "operation-1234",
            mutationType = "food.create",
            payloadJson = "{\"date\":\"2026-07-11\",\"name\":\"Apple\",\"calories\":95}"
        )

        assertTrue(result is AuthenticatedApiResult.Response)
        assertEquals("POST", captured?.method)
        assertEquals("operation-1234", captured?.headers?.get("X-Client-Operation-Id"))
        assertEquals("Bearer access", captured?.headers?.get("Authorization"))
        assertEquals("wear_os", captured?.headers?.get("X-Calibrate-Client-Platform"))
        assertEquals("0.1.0-internal", captured?.headers?.get("X-Calibrate-Client-Version"))
        assertEquals(
            "{\"type\":\"food.create\",\"payload\":{\"date\":\"2026-07-11\",\"name\":\"Apple\",\"calories\":95}}",
            captured?.body
        )
    }

    /** Verifies that expired access token refreshes and persists rotated same-account session. */
    @Test
    fun `expired access token refreshes and persists rotated same-account session`() = runBlocking {
        val store = MemoryTokenStore(session().copy(accessExpiresAtEpochMs = 1_001L))
        val requests = mutableListOf<WatchHttpRequest>()
        val api = AuthenticatedWatchApi(
            tokenStore = store,
            sessionCoordinator = coordinator(store),
            transport = WatchHttpTransport { request ->
                requests += request
                if (request.url.endsWith("/auth/mobile/refresh")) {
                    WatchHttpResponse(
                        200,
                        emptyMap(),
                        """{"user":{"id":7},"access_token":"rotated-access","refresh_token":"rotated-refresh","access_expires_at":"2026-07-11T02:00:00Z","refresh_expires_at":"2026-08-11T02:00:00Z"}"""
                    )
                } else {
                    WatchHttpResponse(304, mapOf("ETag" to "W/\"watch-abc\""), "")
                }
            },
            nowEpochMs = { 1_000L }
        )

        api.getSnapshot(store.value!!, "W/\"watch-old\"")

        assertEquals(2, requests.size)
        assertEquals("rotated-access", store.value?.accessToken)
        assertEquals("rotated-refresh", store.value?.refreshToken)
        assertEquals("Bearer rotated-access", requests.last().headers["Authorization"])
        assertEquals("W/\"watch-old\"", requests.last().headers["If-None-Match"])
        assertTrue(requests.all { it.headers["X-Calibrate-Client-Platform"] == "wear_os" })
        assertTrue(requests.all { it.headers["X-Calibrate-Client-Version"] != null })
    }

    /** Verifies that second unauthorized response after forced refresh requires pairing. */
    @Test
    fun `second unauthorized response after forced refresh requires pairing`() = runBlocking {
        val store = MemoryTokenStore(session())
        var refreshCount = 0
        val api = AuthenticatedWatchApi(
            tokenStore = store,
            sessionCoordinator = coordinator(store),
            transport = WatchHttpTransport { request ->
                if (request.url.endsWith("/auth/mobile/refresh")) {
                    refreshCount++
                    WatchHttpResponse(
                        200,
                        emptyMap(),
                        """{"user":{"id":7},"access_token":"rotated-access","refresh_token":"rotated-refresh","access_expires_at":"2026-07-11T02:00:00Z","refresh_expires_at":"2026-08-11T02:00:00Z"}"""
                    )
                } else {
                    WatchHttpResponse(401, emptyMap(), "{\"message\":\"Unauthorized\"}")
                }
            },
            nowEpochMs = { 1_000L }
        )

        val result = api.getSnapshot(store.value!!, null)

        assertEquals(1, refreshCount)
        assertTrue(result is AuthenticatedApiResult.AuthenticationRequired)
    }

    /** Verifies that upgrade response is terminal for the request without refreshing or clearing session. */
    @Test
    fun `upgrade response is terminal for the request without refreshing or clearing session`() = runBlocking {
        val store = MemoryTokenStore(session())
        var requests = 0
        val api = AuthenticatedWatchApi(
            tokenStore = store,
            sessionCoordinator = coordinator(store),
            transport = WatchHttpTransport {
                requests++
                WatchHttpResponse(
                    426,
                    mapOf("X-Calibrate-Minimum-Client-Version" to "0.2.0"),
                    """{"message":"Update Calibrate for Wear OS to version 0.2.0 or newer to continue.","code":"CLIENT_UPGRADE_REQUIRED","platform":"wear_os","current_version":"0.1.0","minimum_supported_version":"0.2.0","retryable":false}"""
                )
            },
            nowEpochMs = { 1_000L },
            clientVersion = "0.1.0"
        )

        val result = api.getSnapshot(store.value!!, null)

        assertEquals(1, requests)
        assertEquals("access", store.value?.accessToken)
        assertTrue(result is AuthenticatedApiResult.UpgradeRequired)
        assertEquals("0.2.0", (result as AuthenticatedApiResult.UpgradeRequired).minimumVersion)
    }

    private fun session() = SecureSession(
        accessToken = "access",
        refreshToken = "refresh",
        userId = 7,
        serverOrigin = "https://health.example.com",
        watchDeviceId = "watch-7",
        accessExpiresAtEpochMs = 9_999_999_999_999,
        refreshExpiresAtEpochMs = 9_999_999_999_999
    )

    private fun coordinator(store: SecureTokenStore) = AccountSessionCoordinator(
        tokenStore = store,
        accountDataStore = AccountDataStore { }
    )

    private class MemoryTokenStore(var value: SecureSession?) : SecureTokenStore {
        override fun read(): SecureSession? = value
        override fun write(session: SecureSession) { value = session }
        override fun clear() { value = null }
    }
}
