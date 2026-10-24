/** Regression tests and fixtures for Sync Invalidation Protocol. */

package app.calibratehealth.wear.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SyncInvalidationProtocolTest {
    /** Verifies that accepts only the exact paired node account origin and device. */
    @Test
    fun `accepts only the exact paired node account origin and device`() {
        val parsed = parseSyncInvalidation(payload(), "phone-node", scope(), NOW)
        assertEquals("invalidate-0001", parsed?.id)
        assertNull(parseSyncInvalidation(payload(), "other-node", scope(), NOW))
        assertNull(parseSyncInvalidation(payload(userId = 8), "phone-node", scope(), NOW))
        assertNull(parseSyncInvalidation(payload(origin = "https://other.example"), "phone-node", scope(), NOW))
        assertNull(parseSyncInvalidation(payload(watchDeviceId = "watch-2"), "phone-node", scope(), NOW))
    }

    /** Verifies that rejects expired oversized lifetime and extended payloads. */
    @Test
    fun `rejects expired oversized lifetime and extended payloads`() {
        assertNull(parseSyncInvalidation(payload(expiresAt = NOW), "phone-node", scope(), NOW))
        assertNull(parseSyncInvalidation(
            payload(expiresAt = NOW + 11 * 60 * 1000), "phone-node", scope(), NOW
        ))
        assertNull(parseSyncInvalidation(
            payload().dropLast(1) + ",\"calories\":1200}", "phone-node", scope(), NOW
        ))
    }

    /** Verifies that dedupe history is bounded and moves replayed id to newest. */
    @Test
    fun `dedupe history is bounded and moves replayed id to newest`() {
        val existing = (1..20).map { "invalidate-${it.toString().padStart(4, '0')}" }
        val appended = boundedInvalidationIds(existing, "invalidate-0021")
        assertEquals(20, appended.size)
        assertEquals("invalidate-0002", appended.first())
        assertEquals("invalidate-0021", appended.last())
        val replayed = boundedInvalidationIds(appended, "invalidate-0010")
        assertEquals(20, replayed.size)
        assertEquals(1, replayed.count { it == "invalidate-0010" })
        assertEquals("invalidate-0010", replayed.last())
    }

    /** Verifies that authoritative refresh completes only the invalidation captured by its worker. */
    @Test
    fun `authoritative refresh completes only the invalidation captured by its worker`() {
        val accepted = listOf("invalidate-0001")
        assertNull(completedInvalidationIds("invalidate-0002", null, accepted))
        assertNull(completedInvalidationIds("invalidate-0003", "invalidate-0002", accepted))

        assertEquals(
            listOf("invalidate-0001", "invalidate-0002"),
            completedInvalidationIds("invalidate-0002", "invalidate-0002", accepted)
        )
    }

    private fun payload(
        origin: String = "https://health.example",
        userId: Long = 7,
        watchDeviceId: String = "watch-1",
        expiresAt: Long = NOW + 10 * 60 * 1000
    ): String = """
        {"kind":"sync_invalidation","protocol_version":1,"invalidation_id":"invalidate-0001",
        "server_origin":"$origin","user_id":$userId,"watch_device_id":"$watchDeviceId",
        "issued_at_epoch_ms":$NOW,"expires_at_epoch_ms":$expiresAt}
    """.trimIndent()

    private fun scope() = ExpectedSyncInvalidationScope(
        phoneNodeId = "phone-node",
        serverOrigin = "https://health.example",
        userId = 7,
        watchDeviceId = "watch-1",
    )

    private companion object {
        const val NOW = 1_800_000_000_000L
    }
}
