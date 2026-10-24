/** Regression tests and fixtures for Wear Queue Status. */

package app.calibratehealth.wear.actions

import app.calibratehealth.wear.WearSyncStatus
import app.calibratehealth.wear.data.local.MutationState
import app.calibratehealth.wear.data.local.QueuedMutationEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WearQueueStatusTest {
    /** Verifies that pending work takes precedence over older terminal failure. */
    @Test
    fun `pending work takes precedence over older terminal failure`() {
        val status = queueStatus(
            pending = listOf(mutation("pending", MutationState.PENDING, sequenceId = 2)),
            latestTerminal = mutation("failed", MutationState.FAILED, sequenceId = 1, error = "Conflict")
        )

        assertEquals(WearSyncStatus.Pending(1), status)
    }

    /** Verifies that latest failed mutation exposes its actionable error. */
    @Test
    fun `latest failed mutation exposes its actionable error`() {
        val status = queueStatus(
            pending = emptyList(),
            latestTerminal = mutation("failed", MutationState.FAILED, error = "Refresh and try again.")
        )

        assertEquals(WearSyncStatus.Error("Refresh and try again."), status)
    }

    /** Verifies that latest success clears an older in-memory error. */
    @Test
    fun `latest success clears an older in-memory error`() {
        val status = queueStatus(
            pending = emptyList(),
            latestTerminal = mutation("success", MutationState.SUCCEEDED)
        )

        assertTrue(status is WearSyncStatus.Idle)
    }

    private fun mutation(
        id: String,
        state: String,
        sequenceId: Long = 1,
        error: String? = null
    ) = QueuedMutationEntity(
        sequenceId = sequenceId,
        operationId = id,
        mutationType = "food.create",
        payloadJson = "{}",
        state = state,
        attemptCount = 0,
        lastError = error,
        createdAtEpochMs = 1
    )
}
