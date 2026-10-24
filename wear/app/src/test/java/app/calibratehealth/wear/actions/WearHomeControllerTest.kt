/** Regression tests and fixtures for Wear Home Controller. */

package app.calibratehealth.wear.actions

import app.calibratehealth.wear.WearSummary
import app.calibratehealth.wear.data.FakeDailySnapshotRepository
import app.calibratehealth.wear.data.FakeMutationOutboxRepository
import app.calibratehealth.wear.data.FakeQuickAddRepository
import app.calibratehealth.wear.data.FakeSyncMetadataRepository
import app.calibratehealth.wear.data.FakeWearStorage
import app.calibratehealth.wear.sync.OperationIdFactory
import app.calibratehealth.wear.sync.QueuedMutationFactory
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WearHomeControllerTest {
    /** Verifies that durable weight enqueue refreshes calorie glance surfaces immediately. */
    @Test
    fun `durable weight enqueue refreshes calorie glance surfaces immediately`() {
        val storage = FakeWearStorage()
        val refreshedWithDurableWeight = mutableListOf<Boolean>()
        val scopeJob = Job()
        val controller = controller(storage, CoroutineScope(scopeJob + Dispatchers.Unconfined)) {
            refreshedWithDurableWeight += storage.mutations.values.any {
                it.mutationType == "metric.upsert"
            }
        }

        controller.saveWeight(summary(), 72_450)

        assertEquals(listOf(true), refreshedWithDurableWeight)
        assertTrue("metric.upsert" in controller.uiState.value.pendingMutationTypes)
        scopeJob.cancel()
    }

    /** Verifies that non-weight enqueue does not refresh calorie glance surfaces. */
    @Test
    fun `non-weight enqueue does not refresh calorie glance surfaces`() {
        val storage = FakeWearStorage()
        var refreshes = 0
        val scopeJob = Job()
        val controller = controller(storage, CoroutineScope(scopeJob + Dispatchers.Unconfined)) {
            refreshes += 1
        }

        controller.toggleFoodDay(summary())

        assertEquals(0, refreshes)
        scopeJob.cancel()
    }

    private fun controller(
        storage: FakeWearStorage,
        scope: CoroutineScope,
        refreshCalorieGlance: () -> Unit
    ) = WearHomeController(
        snapshots = FakeDailySnapshotRepository(storage, maxRows = 2),
        quickAdds = FakeQuickAddRepository(storage, maxRows = 2),
        metadata = FakeSyncMetadataRepository(storage),
        outbox = FakeMutationOutboxRepository(storage),
        mutationFactory = QueuedMutationFactory(
            operationIds = OperationIdFactory { "operation-1" },
            nowEpochMs = { 1_000L }
        ),
        continueOnPhone = ContinueOnPhoneMessenger { _, callback -> callback(Result.success(Unit)) },
        refreshCalorieGlance = refreshCalorieGlance,
        scope = scope
    )

    private fun summary() = WearSummary(
        localDate = "2026-07-12",
        caloriesRemaining = 640,
        caloriesConsumed = 1_360,
        calorieTarget = 2_000,
        planStatus = "available",
        foodDayComplete = false,
        foodDayRevision = "aaaaaaaaaaaaaaaaaaaaaaaa",
        todayWeightGrams = 72_400,
        todayWeightRevision = "bbbbbbbbbbbbbbbbbbbbbbbb",
        latestWeightGrams = 72_400,
        latestWeightDate = "2026-07-12",
        weightUnit = "kg",
        undoFoodLogId = null,
        undoName = null,
        undoCalories = null,
        fetchedAtEpochMs = 1_000,
        lastSyncAtEpochMs = 1_000
    )
}
