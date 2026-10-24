/** Regression tests and fixtures for Calorie Progress. */

package app.calibratehealth.wear

import org.junit.Assert.assertEquals
import org.junit.Test

class CalorieProgressTest {
    /** Verifies that dashboard diameter uses the full smaller screen dimension. */
    @Test
    fun `dashboard diameter uses the full smaller screen dimension`() {
        assertEquals(120f, summaryDashboardDiameter(widthDp = 192f, heightDp = 120f))
        assertEquals(192f, summaryDashboardDiameter(widthDp = 192f, heightDp = 220f))
        assertEquals(3f, summaryDashboardDiameter(widthDp = 3f, heightDp = 3f))
    }

    /** Verifies that ring expands outward while it fades away. */
    @Test
    fun `ring expands outward while it fades away`() {
        assertEquals(1f, calorieRingScale(1f))
        assertEquals(1.06f, calorieRingScale(0.5f), 0.001f)
        assertEquals(1.12f, calorieRingScale(0f), 0.001f)
    }

    /** Verifies that progress is bounded and handles unavailable targets. */
    @Test
    fun `progress is bounded and handles unavailable targets`() {
        assertEquals(0.5f, calorieProgressFraction(consumed = 1_000, target = 2_000))
        assertEquals(1f, calorieProgressFraction(consumed = 2_500, target = 2_000))
        assertEquals(null, calorieProgressFraction(consumed = null, target = 2_000))
        assertEquals(null, calorieProgressFraction(consumed = 500, target = 0))
    }

    /** Verifies that accessibility description states consumed target and signed balance. */
    @Test
    fun `accessibility description states consumed target and signed balance`() {
        val summary = summary(caloriesRemaining = 640)
        assertEquals(
            "1,360 calories consumed of 2,000. 640 calories remaining.",
            calorieAccessibilityDescription(summary)
        )
        assertEquals(
            "1,360 calories consumed of 2,000. 125 calories over target.",
            calorieAccessibilityDescription(summary.copy(caloriesRemaining = -125))
        )
    }

    /** Verifies that pending weight mutation suppresses cached target and projection until snapshot refresh. */
    @Test
    fun `pending weight mutation suppresses cached target and projection until snapshot refresh`() {
        val cached = summary(caloriesRemaining = 640).copy(
            goalProjectionStatus = "projected",
            goalProjectedEndDate = "2026-10-10"
        )
        val pending = cached.suppressPlanForPendingWeight(setOf("metric.upsert"))

        assertEquals(WEIGHT_SYNCING_PLAN_STATUS, pending.planStatus)
        assertEquals(null, pending.calorieTarget)
        assertEquals(null, pending.caloriesRemaining)
        assertEquals("Projection unavailable", goalProjectionLabel(pending))
        assertEquals("Rechecking calorie plan", goalProgressHeadline(pending))
        assertEquals(cached, cached.suppressPlanForPendingWeight(setOf("food.create")))
    }

    /** Verifies that goal copy prioritizes progress and handles completion. */
    @Test
    fun `goal copy prioritizes progress and handles completion`() {
        val goal = summary(caloriesRemaining = 640).copy(
            goalStartWeightGrams = 90_000,
            goalTargetWeightGrams = 80_000,
            goalCurrentWeightGrams = 85_800,
            goalDailyDeficit = 500,
            goalProgressPercent = 42.0,
            goalRemainingWeightGrams = 5_800,
            goalIsComplete = false,
            goalProjectionStatus = "projected",
            goalProjectedEndDate = "2026-10-10"
        )

        assertEquals("42% to goal", goalProgressHeadline(goal))
        assertEquals(0.42f, goalProgressFraction(goal))
        assertEquals("Current 85.8 kg | Goal 80.0 kg", goalProgressDetail(goal))
        assertEquals("Projected Oct 10, 2026", goalProjectionLabel(goal))
        assertEquals("Goal reached", goalProgressHeadline(goal.copy(goalIsComplete = true)))
        assertEquals(1f, goalProgressFraction(goal.copy(goalIsComplete = true)))
        assertEquals("Goal reached", goalProjectionLabel(goal.copy(goalProjectionStatus = "reached", goalProjectedEndDate = null)))
        val maintenance = goal.copy(
            goalDailyDeficit = 0,
            goalIsComplete = true,
            goalProjectionStatus = "maintenance",
            goalProjectedEndDate = null
        )
        assertEquals("Maintenance goal", goalProgressHeadline(maintenance))
        assertEquals(null, goalProgressFraction(maintenance))
        assertEquals("No projected date", goalProjectionLabel(maintenance))
        assertEquals(
            "Maintenance goal. Current 85.8 kg. Goal 80.0 kg. 5.8 kg from target. No projected date.",
            goalAccessibilityDescription(maintenance)
        )
        assertEquals(
            "Projection unavailable",
            goalProjectionLabel(goal.copy(goalProjectedEndDate = "not-a-date"))
        )
        assertEquals("Projection unavailable", goalProjectionLabel(goal.copy(planStatus = "requires_review")))
        assertEquals("Review calorie plan", goalProgressHeadline(goal.copy(planStatus = "requires_review")))
        assertEquals(
            "Review calorie plan. Current 85.8 kg. Goal 80.0 kg. 5.8 kg remaining. Projection unavailable.",
            goalAccessibilityDescription(goal.copy(planStatus = "requires_review"))
        )
    }

    private fun summary(caloriesRemaining: Int?) = WearSummary(
        localDate = "2026-07-12",
        caloriesRemaining = caloriesRemaining,
        caloriesConsumed = 1_360,
        calorieTarget = 2_000,
        planStatus = "available",
        foodDayComplete = false,
        foodDayRevision = null,
        todayWeightGrams = 72_400,
        todayWeightRevision = null,
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
