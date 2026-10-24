/** Regression tests and fixtures for Calorie Complication Formatter. */

package app.calibratehealth.wear.complication

import app.calibratehealth.wear.tile.CalibrateTileSnapshot
import org.junit.Assert.assertEquals
import org.junit.Test

class CalorieComplicationFormatterTest {
    /** Verifies that formats calories remaining for text and ranged slots. */
    @Test
    fun `formats calories remaining for text and ranged slots`() {
        val result = CalorieComplicationFormatter.format(snapshot(remaining = 595), NOW)

        assertEquals("595", result.text)
        assertEquals("kcal left", result.title)
        assertEquals(1_240f, result.rangeValue)
        assertEquals(1_835f, result.rangeMaximum)
    }

    /** Verifies that formats over-budget state without pink or ambiguous copy. */
    @Test
    fun `formats over-budget state without pink or ambiguous copy`() {
        val result = CalorieComplicationFormatter.format(snapshot(remaining = -145, consumed = 1_980), NOW)

        assertEquals("145", result.text)
        assertEquals("kcal over", result.title)
        assertEquals("145 calories over target. 1980 consumed of 1835.", result.contentDescription)
        assertEquals(1_835f, result.rangeValue)
    }

    /** Verifies that returns a useful empty state when cache is unavailable. */
    @Test
    fun `returns a useful empty state when cache is unavailable`() {
        val result = CalorieComplicationFormatter.format(null, NOW)

        assertEquals("--", result.text)
        assertEquals("calories", result.title)
        assertEquals(1f, result.rangeMaximum)
    }

    /** Verifies that marks an old cache as visibly approximate. */
    @Test
    fun `marks an old cache as visibly approximate`() {
        val result = CalorieComplicationFormatter.format(
            snapshot(remaining = 595, cachedAtEpochMs = NOW - 7 * HOUR_MS),
            NOW
        )

        assertEquals("~595", result.text)
        assertEquals(true, result.contentDescription.startsWith("Cached data may be out of date."))
    }

    /** Verifies that shows paused instead of calorie progress. */
    @Test
    fun `shows paused instead of calorie progress`() {
        val result = CalorieComplicationFormatter.format(
            snapshot(remaining = 595).copy(foodDayStatus = "PAUSED"),
            NOW
        )

        assertEquals("Paused", result.text)
        assertEquals("tracking", result.title)
        assertEquals(1f, result.rangeMaximum)
    }

    /** Verifies that suppresses cached target when the plan is not available. */
    @Test
    fun `suppresses cached target when the plan is not available`() {
        val result = CalorieComplicationFormatter.format(
            snapshot(remaining = 595).copy(planStatus = "requires_review"),
            NOW
        )

        assertEquals("--", result.text)
        assertEquals("plan", result.title)
        assertEquals(1f, result.rangeMaximum)
    }

    /** Verifies that shows syncing instead of cached balance during a pending weight change. */
    @Test
    fun `shows syncing instead of cached balance during a pending weight change`() {
        val result = CalorieComplicationFormatter.format(
            snapshot(remaining = 595).copy(planStatus = "weight_syncing"),
            NOW
        )

        assertEquals("--", result.text)
        assertEquals("syncing", result.title)
        assertEquals(1f, result.rangeMaximum)
    }

    private fun snapshot(
        remaining: Int,
        consumed: Int = 1_240,
        cachedAtEpochMs: Long = NOW
    ) = CalibrateTileSnapshot(
        caloriesConsumed = consumed,
        calorieTarget = 1_835,
        caloriesRemaining = remaining,
        cachedAtEpochMs = cachedAtEpochMs,
        planStatus = "available"
    )

    private companion object {
        const val NOW = 1_800_000_000_000L
        const val HOUR_MS = 60 * 60 * 1_000L
    }
}
