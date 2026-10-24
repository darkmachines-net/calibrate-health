/** Regression tests and fixtures for Repository Contracts. */

package app.calibratehealth.wear.data

import app.calibratehealth.wear.data.local.DailySnapshotEntity
import app.calibratehealth.wear.data.local.QueuedMutationEntity
import app.calibratehealth.wear.data.local.QuickAddItemEntity
import app.calibratehealth.wear.data.security.SecureSession
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RepositoryContractsTest {
    /** Verifies that snapshot and quick-add caches keep their configured bounds. */
    @Test
    fun `snapshot and quick-add caches keep their configured bounds`() = runBlocking {
        val storage = FakeWearStorage()
        val snapshots = FakeDailySnapshotRepository(storage, maxRows = 2)
        listOf("2026-07-09", "2026-07-11", "2026-07-10").forEach { date ->
            snapshots.cache(snapshot(date))
        }
        assertEquals(listOf("2026-07-11", "2026-07-10"), snapshots.allNewestFirst().map { it.localDate })

        val quickAdds = FakeQuickAddRepository(storage, maxRows = 2)
        quickAdds.cache(listOf(quickAdd("third", 3), quickAdd("first", 1), quickAdd("second", 2)))
        assertEquals(listOf("first", "second"), quickAdds.all().map { it.quickAddId })
        quickAdds.cache(emptyList())
        assertTrue(quickAdds.all().isEmpty())
    }

    /** Verifies that outbox ordering and stable operation ids survive repository recreation. */
    @Test
    fun `outbox ordering and stable operation ids survive repository recreation`() = runBlocking {
        val storage = FakeWearStorage()
        val firstProcess = FakeMutationOutboxRepository(storage)
        assertTrue(firstProcess.enqueue(mutation("b", 100)))
        assertTrue(firstProcess.enqueue(mutation("a", 100)))
        assertTrue(firstProcess.enqueue(mutation("c", 200)))
        assertFalse(firstProcess.enqueue(mutation("a", 999)))
        assertEquals(listOf("b", "a", "c"), firstProcess.pendingInFifoOrder().map { it.operationId })

        assertTrue(firstProcess.recordRetry("b", error = "offline"))
        val afterRestart = FakeMutationOutboxRepository(storage)
        assertEquals("b", afterRestart.head()?.operationId)
        assertEquals(1, afterRestart.head()?.attemptCount)

        assertTrue(afterRestart.recordServerSuccess("b"))
        assertEquals(listOf("b", "a", "c"), afterRestart.activeInFifoOrder().map { it.operationId })
        assertEquals("a", afterRestart.head()?.operationId)
        afterRestart.confirmSnapshotRefresh()
        assertEquals(listOf("a", "c"), afterRestart.activeInFifoOrder().map { it.operationId })
    }

    /** Verifies that secure session fake persists across store recreation. */
    @Test
    fun `secure session fake persists across store recreation`() {
        val storage = FakeWearStorage()
        val session = SecureSession(
            accessToken = "access-token",
            refreshToken = "refresh-token",
            userId = 1,
            serverOrigin = "https://health.example.com",
            watchDeviceId = "watch-1",
            accessExpiresAtEpochMs = 123_456,
            refreshExpiresAtEpochMs = 223_456
        )
        FakeSecureTokenStore(storage).write(session)
        assertEquals(session, FakeSecureTokenStore(storage).read())
    }

    private fun snapshot(localDate: String) = DailySnapshotEntity(
        localDate = localDate,
        caloriesConsumed = null,
        calorieTarget = null,
        latestWeightGrams = null,
        serverRevision = null,
        fetchedAtEpochMs = 0
    )

    private fun quickAdd(id: String, rank: Int) = QuickAddItemEntity(
        quickAddId = id,
        name = id,
        mealPeriod = null,
        calories = 100,
        servingDescription = "1 serving",
        mutationPayloadJson = "{}",
        sortRank = rank,
        updatedAtEpochMs = 0
    )

    private fun mutation(id: String, createdAt: Long) = QueuedMutationEntity(
        operationId = id,
        mutationType = "food.create",
        payloadJson = "{}",
        createdAtEpochMs = createdAt
    )
}
