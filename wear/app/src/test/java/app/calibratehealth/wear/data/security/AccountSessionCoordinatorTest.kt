/** Regression tests and fixtures for Account Session Coordinator. */

package app.calibratehealth.wear.data.security

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AccountSessionCoordinatorTest {
    /** Verifies that local clear removes credentials before account scoped data. */
    @Test
    fun `local clear removes credentials before account scoped data`() = runBlocking {
        val events = mutableListOf<String>()
        val tokenStore = RecordingTokenStore(session(userId = 1), events)

        AccountSessionCoordinator(tokenStore, RecordingAccountDataStore(events)).clear()

        assertEquals(listOf("token.clear", "data.clear"), events)
        assertNull(tokenStore.session)
    }

    /** Verifies that account replacement clears credentials then account data before writing session. */
    @Test
    fun `account replacement clears credentials then account data before writing session`() = runBlocking {
        val events = mutableListOf<String>()
        val tokenStore = RecordingTokenStore(session(userId = 1), events)
        val dataStore = RecordingAccountDataStore(events)

        AccountSessionCoordinator(tokenStore, dataStore).replace(session(userId = 2))

        assertEquals(listOf("token.clear", "data.clear", "token.write"), events)
        assertEquals(2L, tokenStore.session?.userId)
    }

    /** Verifies that same account refresh replaces tokens without discarding cache. */
    @Test
    fun `same account refresh replaces tokens without discarding cache`() = runBlocking {
        val events = mutableListOf<String>()
        val tokenStore = RecordingTokenStore(session(accessToken = "old-access"), events)

        AccountSessionCoordinator(tokenStore, RecordingAccountDataStore(events)).replace(
            session(accessToken = "new-access")
        )

        assertEquals(listOf("token.write"), events)
        assertEquals("new-access", tokenStore.session?.accessToken)
    }

    /** Verifies that late refresh cannot restore an account that was replaced. */
    @Test
    fun `late refresh cannot restore an account that was replaced`() = runBlocking {
        val events = mutableListOf<String>()
        val active = session(userId = 2)
        val tokenStore = RecordingTokenStore(active, events)
        val coordinator = AccountSessionCoordinator(
            tokenStore,
            RecordingAccountDataStore(events),
            AccountStateCriticalSection.isolatedForTest()
        )

        val replaced = coordinator.replaceIfScopeCurrent(
            expected = AccountScope("https://health.example.com", 1),
            session = session(userId = 1, accessToken = "late-old-account-token")
        )

        assertEquals(false, replaced)
        assertTrue(events.isEmpty())
        assertEquals(active, tokenStore.session)
    }

    /** Verifies that failed account-data deletion leaves no credential usable. */
    @Test
    fun `failed account-data deletion leaves no credential usable`() = runBlocking {
        val events = mutableListOf<String>()
        val tokenStore = RecordingTokenStore(session(userId = 1), events)
        val dataStore = RecordingAccountDataStore(events, failClear = true)

        val error = runCatching {
            AccountSessionCoordinator(tokenStore, dataStore).replace(session(userId = 2))
        }.exceptionOrNull()

        assertTrue(error is IllegalStateException)
        assertEquals(listOf("token.clear", "data.clear"), events)
        assertNull(tokenStore.session)
    }

    /** Verifies that invalid replacement is rejected before existing state changes. */
    @Test
    fun `invalid replacement is rejected before existing state changes`() = runBlocking {
        val events = mutableListOf<String>()
        val original = session()
        val tokenStore = RecordingTokenStore(original, events)

        val error = runCatching {
            AccountSessionCoordinator(tokenStore, RecordingAccountDataStore(events)).replace(
                session(accessExpiresAtEpochMs = 300, refreshExpiresAtEpochMs = 200)
            )
        }.exceptionOrNull()

        assertTrue(error is IllegalArgumentException)
        assertTrue(events.isEmpty())
        assertEquals(original, tokenStore.session)
    }

    /** Verifies that nonpositive backend user id is rejected before existing state changes. */
    @Test
    fun `nonpositive backend user id is rejected before existing state changes`() = runBlocking {
        val events = mutableListOf<String>()
        val original = session()
        val tokenStore = RecordingTokenStore(original, events)

        val error = runCatching {
            AccountSessionCoordinator(tokenStore, RecordingAccountDataStore(events)).replace(
                session(userId = 0)
            )
        }.exceptionOrNull()

        assertTrue(error is IllegalArgumentException)
        assertTrue(events.isEmpty())
        assertEquals(original, tokenStore.session)
    }

    private fun session(
        accessToken: String = "access-token",
        userId: Long = 1,
        accessExpiresAtEpochMs: Long = 100,
        refreshExpiresAtEpochMs: Long = 200
    ) = SecureSession(
        accessToken = accessToken,
        refreshToken = "refresh-token",
        userId = userId,
        serverOrigin = "https://health.example.com",
        watchDeviceId = "watch-1",
        accessExpiresAtEpochMs = accessExpiresAtEpochMs,
        refreshExpiresAtEpochMs = refreshExpiresAtEpochMs
    )

    private class RecordingTokenStore(
        var session: SecureSession?,
        private val events: MutableList<String>
    ) : SecureTokenStore {
        override fun read(): SecureSession? = session

        override fun write(session: SecureSession) {
            events += "token.write"
            this.session = session
        }

        override fun clear() {
            events += "token.clear"
            session = null
        }
    }

    private class RecordingAccountDataStore(
        private val events: MutableList<String>,
        private val failClear: Boolean = false
    ) : AccountDataStore {
        override suspend fun clearAll() {
            events += "data.clear"
            if (failClear) error("database unavailable")
        }
    }
}
