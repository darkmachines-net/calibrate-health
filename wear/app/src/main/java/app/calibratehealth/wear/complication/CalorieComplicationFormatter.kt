/** Bounded calorie complication text, progress, freshness, and accessibility presentation. */

package app.calibratehealth.wear.complication

import app.calibratehealth.wear.tile.CalibrateTileSnapshot
import app.calibratehealth.wear.tile.WEIGHT_SYNCING_TILE_PLAN_STATUS
import kotlin.math.abs

data class CalorieComplicationContent(
    val text: String,
    val title: String,
    val contentDescription: String,
    val rangeValue: Float,
    val rangeMaximum: Float
)

/** Formats the same cache-only calorie state for short-text and progress watch-face slots. */
object CalorieComplicationFormatter {
    private const val STALE_AFTER_MS = 6 * 60 * 60 * 1_000L

    /** Formats cached calorie balance for a complication with explicit unavailable, paused, and stale states. */
    fun format(snapshot: CalibrateTileSnapshot?, nowEpochMs: Long): CalorieComplicationContent {
        if (snapshot == null) {
            return CalorieComplicationContent(
                text = "--",
                title = "calories",
                contentDescription = "Calorie balance unavailable. Open Calibrate to sync.",
                rangeValue = 0f,
                rangeMaximum = 1f
            )
        }

        if (snapshot.foodDayStatus == "PAUSED") {
            return CalorieComplicationContent(
                text = "Paused",
                title = "tracking",
                contentDescription = "Calorie tracking paused. Open Calibrate on your phone to review.",
                rangeValue = 0f,
                rangeMaximum = 1f
            )
        }

        if (snapshot.planStatus == WEIGHT_SYNCING_TILE_PLAN_STATUS) {
            return CalorieComplicationContent(
                text = "--",
                title = "syncing",
                contentDescription = "Weight change syncing. Calorie balance will return after the server rechecks the plan.",
                rangeValue = 0f,
                rangeMaximum = 1f
            )
        }

        if (snapshot.planStatus != "available") {
            return CalorieComplicationContent(
                text = "--",
                title = "plan",
                contentDescription = "Calorie plan unavailable. Open Calibrate to review.",
                rangeValue = 0f,
                rangeMaximum = 1f
            )
        }

        val consumed = snapshot.caloriesConsumed?.coerceAtLeast(0)
        val target = snapshot.calorieTarget?.takeIf { it > 0 }
        val remaining = snapshot.caloriesRemaining
            ?: if (consumed != null && target != null) target - consumed else null
        if (remaining == null || consumed == null || target == null) {
            return CalorieComplicationContent(
                text = "--",
                title = "calories",
                contentDescription = "Calorie balance unavailable. Open Calibrate to sync.",
                rangeValue = 0f,
                rangeMaximum = 1f
            )
        }

        val isOver = remaining < 0
        val isStale = nowEpochMs - snapshot.cachedAtEpochMs >= STALE_AFTER_MS
        val balance = "${if (isStale) "~" else ""}${compactCount(abs(remaining))}"
        val title = if (isOver) "kcal over" else "kcal left"
        val calorieDescription = if (isOver) {
            "${abs(remaining)} calories over target. $consumed consumed of $target."
        } else {
            "$remaining calories remaining. $consumed consumed of $target."
        }
        val description = if (isStale) "Cached data may be out of date. $calorieDescription" else calorieDescription
        return CalorieComplicationContent(
            text = balance,
            title = title,
            contentDescription = description,
            rangeValue = consumed.coerceAtMost(target).toFloat(),
            rangeMaximum = target.toFloat()
        )
    }

    private fun compactCount(value: Int): String = when {
        value < 10_000 -> value.toString()
        value < 1_000_000 -> "${value / 1_000}k"
        else -> "999k+"
    }
}
