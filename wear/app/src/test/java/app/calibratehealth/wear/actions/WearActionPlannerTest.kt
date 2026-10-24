/** Regression tests and fixtures for Wear Action Planner. */

package app.calibratehealth.wear.actions

import app.calibratehealth.wear.WearSummary
import app.calibratehealth.wear.data.local.QuickAddItemEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WearActionPlannerTest {
    /** Verifies that quick add preserves the immutable server draft. */
    @Test
    fun `quick add preserves the immutable server draft`() {
        val draft = "{\"date\":\"2026-07-12\",\"name\":\"Oats\",\"calories\":320}"
        val item = QuickAddItemEntity("recent:1", "Oats", "BREAKFAST", 320, "Recent serving", draft, 0, 1)
        assertEquals(PlannedMutation("food.create", draft), WearActionPlanner.quickAdd(item))
    }

    /** Verifies that completion and weight carry their entity revisions. */
    @Test
    fun `completion and weight carry their entity revisions`() {
        val summary = summary()
        assertEquals(
            PlannedMutation(
                "food_day.set_complete",
                "{\"local_date\":\"2026-07-12\",\"is_complete\":true,\"expected_revision\":\"aaaaaaaaaaaaaaaaaaaaaaaa\"}"
            ),
            WearActionPlanner.setFoodDayComplete(summary)
        )
        assertEquals(
            PlannedMutation(
                "metric.upsert",
                "{\"local_date\":\"2026-07-12\",\"weight_grams\":72450,\"expected_revision\":\"bbbbbbbbbbbbbbbbbbbbbbbb\"}"
            ),
            WearActionPlanner.saveWeight(summary, 72_450)
        )
    }

    /** Verifies that undo is planned only from a complete server candidate. */
    @Test
    fun `undo is planned only from a complete server candidate`() {
        assertEquals(
            PlannedMutation("food.delete", "{\"food_log_id\":41}"),
            WearActionPlanner.undo(summary())
        )
        assertNull(WearActionPlanner.undo(summary().copy(undoName = null)))
    }

    private fun summary() = WearSummary(
        localDate = "2026-07-12",
        caloriesRemaining = 640,
        caloriesConsumed = 1_360,
        calorieTarget = 2_000,
        foodDayComplete = false,
        foodDayRevision = "aaaaaaaaaaaaaaaaaaaaaaaa",
        todayWeightGrams = 72_400,
        todayWeightRevision = "bbbbbbbbbbbbbbbbbbbbbbbb",
        latestWeightGrams = 72_400,
        latestWeightDate = "2026-07-12",
        weightUnit = "kg",
        undoFoodLogId = 41,
        undoName = "Yogurt",
        undoCalories = 130,
        fetchedAtEpochMs = 1_000,
        lastSyncAtEpochMs = 1_000
    )
}
