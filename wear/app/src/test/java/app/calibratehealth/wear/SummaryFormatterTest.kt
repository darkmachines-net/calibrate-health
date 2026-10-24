/** Regression tests and fixtures for Summary Formatter. */

package app.calibratehealth.wear

import org.junit.Assert.assertEquals
import org.junit.Test

class SummaryFormatterTest {
    /** Verifies that formats cached summary without changing calorie sign meaning. */
    @Test
    fun `formats cached summary without changing calorie sign meaning`() {
        val base = summary(caloriesRemaining = 640)
        assertEquals("640 kcal left", SummaryFormatter.caloriesRemaining(base))
        assertEquals("125 kcal over", SummaryFormatter.caloriesRemaining(base.copy(caloriesRemaining = -125)))
        assertEquals("1,360 of 2,000 kcal", SummaryFormatter.calorieProgress(base))
    }

    /** Verifies that formats canonical grams at the selected unit edge. */
    @Test
    fun `formats canonical grams at the selected unit edge`() {
        assertEquals("72.4 kg", SummaryFormatter.weight(72_400, "kg"))
        assertEquals("159.6 lb", SummaryFormatter.weight(72_400, "lb"))
        assertEquals("--", SummaryFormatter.weight(null, "kg"))
    }

    /** Verifies that surfaces pending and error sync states explicitly. */
    @Test
    fun `surfaces pending and error sync states explicitly`() {
        val base = summary()
        assertEquals("2 changes pending", SummaryFormatter.sync(WearSyncStatus.Pending(2), base.lastSyncAtEpochMs))
        assertEquals("A queued change failed", SummaryFormatter.sync(WearSyncStatus.Error("A queued change failed"), null))
    }

    private fun summary(
        caloriesRemaining: Int? = 640
    ) = WearSummary(
        localDate = "2026-07-12",
        caloriesRemaining = caloriesRemaining,
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
        undoFoodLogId = 41,
        undoName = "Yogurt",
        undoCalories = 130,
        fetchedAtEpochMs = 1_000,
        lastSyncAtEpochMs = 1_000
    )
}
