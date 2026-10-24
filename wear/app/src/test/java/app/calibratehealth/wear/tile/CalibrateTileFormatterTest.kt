/** Regression tests and fixtures for Calibrate Tile Formatter. */

package app.calibratehealth.wear.tile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CalibrateTileFormatterTest {
    /** Verifies that formats remaining consumed target and freshness. */
    @Test
    fun `formats remaining consumed target and freshness`() {
        val result = CalibrateTileFormatter.format(
            CalibrateTileSnapshot(
                caloriesConsumed = 1_500,
                calorieTarget = 2_000,
                caloriesRemaining = 500,
                cachedAtEpochMs = NOW - 5 * MINUTE_MS,
                planStatus = "available"
            ),
            NOW
        )

        assertEquals("500 kcal left", result.calorieLine)
        assertEquals("1,500 of 2,000 kcal", result.consumedLine)
        assertEquals("5 min ago", result.statusLine)
        assertFalse(result.isStale)
    }

    /** Verifies that formats calories over and marks old cache stale. */
    @Test
    fun `formats calories over and marks old cache stale`() {
        val result = CalibrateTileFormatter.format(
            CalibrateTileSnapshot(
                caloriesConsumed = 2_250,
                calorieTarget = 2_000,
                caloriesRemaining = -250,
                cachedAtEpochMs = NOW - 7 * HOUR_MS,
                planStatus = "available"
            ),
            NOW
        )

        assertEquals("250 kcal over", result.calorieLine)
        assertEquals("2,250 of 2,000 kcal", result.consumedLine)
        assertEquals("Stale - 7 hr ago", result.statusLine)
        assertTrue(result.isStale)
    }

    /** Verifies that handles partial cache without inventing values. */
    @Test
    fun `handles partial cache without inventing values`() {
        val result = CalibrateTileFormatter.format(
            CalibrateTileSnapshot(
                caloriesConsumed = 400,
                calorieTarget = null,
                caloriesRemaining = null,
                cachedAtEpochMs = NOW + MINUTE_MS,
                planStatus = "available"
            ),
            NOW
        )

        assertEquals("Calories --", result.calorieLine)
        assertEquals("Consumed / target --", result.consumedLine)
        assertEquals("Updated now", result.statusLine)
        assertFalse(result.isStale)
    }

    /** Verifies that keeps a recent calorie cache fresh. */
    @Test
    fun `keeps a recent calorie cache fresh`() {
        val result = CalibrateTileFormatter.format(
            CalibrateTileSnapshot(
                caloriesConsumed = 1_000,
                calorieTarget = 2_000,
                caloriesRemaining = 1_000,
                cachedAtEpochMs = NOW - 2 * MINUTE_MS,
                planStatus = "available"
            ),
            NOW
        )

        assertEquals("2 min ago", result.statusLine)
        assertFalse(result.isStale)
    }

    /** Verifies that shows an explicit empty cache state. */
    @Test
    fun `shows an explicit empty cache state`() {
        val result = CalibrateTileFormatter.format(null, NOW)

        assertEquals("Open calibrate", result.calorieLine)
        assertEquals("No cached data", result.statusLine)
        assertTrue(result.isStale)
    }

    /** Verifies that shows paused instead of calorie progress. */
    @Test
    fun `shows paused instead of calorie progress`() {
        val result = CalibrateTileFormatter.format(
            CalibrateTileSnapshot(
                caloriesConsumed = 500,
                calorieTarget = 2_000,
                caloriesRemaining = 1_500,
                cachedAtEpochMs = NOW,
                foodDayStatus = "PAUSED"
            ),
            NOW
        )

        assertEquals("Paused", result.calorieLine)
        assertEquals("Calorie tracking paused", result.consumedLine)
        assertEquals("Open app to review", result.statusLine)
    }

    /** Verifies that shows logged calories without target math when plan needs review. */
    @Test
    fun `shows logged calories without target math when plan needs review`() {
        val result = CalibrateTileFormatter.format(
            CalibrateTileSnapshot(
                caloriesConsumed = 500,
                calorieTarget = 2_000,
                caloriesRemaining = 1_500,
                cachedAtEpochMs = NOW,
                planStatus = "requires_review"
            ),
            NOW
        )

        assertEquals("Plan unavailable", result.calorieLine)
        assertEquals("500 kcal logged", result.consumedLine)
        assertEquals("Open app to review", result.statusLine)
    }

    /** Verifies that pending weight mutation shows syncing without cached target math. */
    @Test
    fun `pending weight mutation shows syncing without cached target math`() {
        val cached = CalibrateTileSnapshot(500, 2_000, 1_500, NOW, planStatus = "available")
        val pending = suppressTilePlanForPendingWeight(cached, setOf("metric.upsert"))
        val result = CalibrateTileFormatter.format(pending, NOW)

        assertEquals("Rechecking plan", result.calorieLine)
        assertEquals("500 kcal logged", result.consumedLine)
        assertEquals("Weight syncing", result.statusLine)
        assertEquals(null, pending.calorieTarget)
    }

    private companion object {
        const val NOW = 1_800_000_000_000L
        const val MINUTE_MS = 60_000L
        const val HOUR_MS = 60 * MINUTE_MS
    }
}
