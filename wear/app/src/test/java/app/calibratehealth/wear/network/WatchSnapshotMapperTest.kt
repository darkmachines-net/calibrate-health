/** Regression tests and fixtures for Watch Snapshot Mapper. */

package app.calibratehealth.wear.network

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import app.calibratehealth.wear.notifications.WearReminderType

class WatchSnapshotMapperTest {
    /** Verifies that maps bounded snapshot and preserves quick-add draft as mutation payload. */
    @Test
    fun `maps bounded snapshot and preserves quick-add draft as mutation payload`() {
        val result = WatchSnapshotMapper.map(validSnapshot(), fetchedAtEpochMs = 42L)

        assertEquals("2026-07-11", result.dailySnapshot.localDate)
        assertEquals(750, result.dailySnapshot.caloriesConsumed)
        assertEquals(2_000, result.dailySnapshot.calorieTarget)
        assertEquals(1_250, result.dailySnapshot.caloriesRemaining)
        assertEquals("available", result.dailySnapshot.planStatus)
        assertEquals(1_500, result.dailySnapshot.minimumCalorieTarget)
        assertEquals(true, result.dailySnapshot.foodDayComplete)
        assertEquals("COMPLETE", result.dailySnapshot.foodDayStatus)
        assertEquals(true, result.dailySnapshot.foodDayRepresentative)
        assertEquals(1_783_731_600_000L, result.dailySnapshot.foodDayCompletedAtEpochMs)
        assertEquals("fedcba9876543210fedcba98", result.dailySnapshot.foodDayRevision)
        assertEquals(81_500L, result.dailySnapshot.todayWeightGrams)
        assertEquals("abcdef0123456789abcdef01", result.dailySnapshot.todayWeightRevision)
        assertEquals(81_500L, result.dailySnapshot.latestWeightGrams)
        assertEquals("abcdef0123456789abcdef01", result.dailySnapshot.latestWeightRevision)
        assertEquals("2026-07-11", result.dailySnapshot.latestWeightDate)
        assertEquals("LB", result.dailySnapshot.weightUnit)
        assertEquals(44L, result.dailySnapshot.undoFoodLogId)
        assertEquals("Yogurt", result.dailySnapshot.undoName)
        assertEquals(120, result.dailySnapshot.undoCalories)
        assertEquals(1_783_731_900_000L, result.dailySnapshot.undoCreatedAtEpochMs)
        assertEquals(42L, result.dailySnapshot.fetchedAtEpochMs)
        assertEquals("0123456789abcdef01234567", result.revision)
        assertEquals(2, result.reminders.size)
        assertEquals(setOf(WearReminderType.FOOD, WearReminderType.WEIGHT), result.reminders.map { it.type }.toSet())
        assertEquals(1, result.quickAddItems.size)
        assertEquals("my-food:4", result.quickAddItems.single().quickAddId)
        assertEquals(
            "{\"date\":\"2026-07-11\",\"meal_period\":\"LUNCH\",\"my_food_id\":4,\"servings_consumed\":1}",
            result.quickAddItems.single().mutationPayloadJson
        )
    }

    /** Verifies that rejects duplicate quick-add ids and malformed revisions. */
    @Test
    fun `rejects duplicate quick-add ids and malformed revisions`() {
        val snapshot = validSnapshot()
        val quickAdd =
            "{\"id\":\"my-food:4\",\"source\":\"pinned\",\"label\":\"Yogurt\",\"calories\":120," +
                "\"draft\":{\"date\":\"2026-07-11\",\"meal_period\":\"LUNCH\",\"my_food_id\":4," +
                "\"servings_consumed\":1}}"
        val duplicated = snapshot.replace(
            quickAdd,
            "$quickAdd,$quickAdd"
        )
        assertTrue(duplicated != snapshot)
        assertTrue(runCatching { WatchSnapshotMapper.map(duplicated, 42L) }.isFailure)
        assertTrue(runCatching {
            WatchSnapshotMapper.map(validSnapshot().replace("0123456789abcdef01234567", "bad"), 42L)
        }.isFailure)
    }

    /** Verifies that maps optional goal progress and remains compatible with snapshots that omit it. */
    @Test
    fun `maps optional goal progress and remains compatible with snapshots that omit it`() {
        val withoutGoal = WatchSnapshotMapper.map(validSnapshot(), 42L).dailySnapshot
        assertEquals(null, withoutGoal.goalStartWeightGrams)

        val goal =
            "\"goal\":{\"start_weight_grams\":90000,\"target_weight_grams\":75000," +
                "\"current_weight_grams\":80000,\"daily_deficit\":500,\"progress_percent\":66.7," +
                "\"remaining_weight_grams\":5000,\"is_complete\":false," +
                "\"projection\":{\"status\":\"projected\",\"projected_end_date\":\"2026-10-10\"," +
                "\"reason_code\":null}},"
        val withGoal = validSnapshot().replace("\"quick_add\":", "$goal\"quick_add\":")
        val mapped = WatchSnapshotMapper.map(withGoal, 42L).dailySnapshot

        assertEquals(90_000L, mapped.goalStartWeightGrams)
        assertEquals(75_000L, mapped.goalTargetWeightGrams)
        assertEquals(80_000L, mapped.goalCurrentWeightGrams)
        assertEquals(500, mapped.goalDailyDeficit)
        assertEquals(66.7, mapped.goalProgressPercent)
        assertEquals(5_000L, mapped.goalRemainingWeightGrams)
        assertEquals(false, mapped.goalIsComplete)
        assertEquals("projected", mapped.goalProjectionStatus)
        assertEquals("2026-10-10", mapped.goalProjectedEndDate)
    }

    /** Verifies that maps maintenance as ongoing neutral progress. */
    @Test
    fun `maps maintenance as ongoing neutral progress`() {
        val maintenanceGoal =
            "\"goal\":{\"start_weight_grams\":80000,\"target_weight_grams\":80000," +
                "\"current_weight_grams\":80100,\"daily_deficit\":0,\"progress_percent\":null," +
                "\"remaining_weight_grams\":100,\"is_complete\":false," +
                "\"projection\":{\"status\":\"maintenance\",\"projected_end_date\":null,\"reason_code\":null}},"
        val mapped = WatchSnapshotMapper.map(
            validSnapshot().replace("\"quick_add\":", "$maintenanceGoal\"quick_add\":"),
            42L
        ).dailySnapshot

        assertEquals(80_100L, mapped.goalCurrentWeightGrams)
        assertEquals(null, mapped.goalProgressPercent)
        assertEquals(false, mapped.goalIsComplete)
        assertEquals("maintenance", mapped.goalProjectionStatus)
    }

    /** Verifies that rejects incomplete directional or out-of-range goal progress. */
    @Test
    fun `rejects incomplete directional or out-of-range goal progress`() {
        val incompleteGoal =
            "\"goal\":{\"start_weight_grams\":90000,\"target_weight_grams\":75000," +
                "\"current_weight_grams\":80000,\"daily_deficit\":500,\"progress_percent\":null," +
                "\"remaining_weight_grams\":5000,\"is_complete\":false},"
        val invalidProgress =
            "\"goal\":{\"start_weight_grams\":90000,\"target_weight_grams\":75000," +
                "\"current_weight_grams\":80000,\"daily_deficit\":500,\"progress_percent\":101," +
                "\"remaining_weight_grams\":5000,\"is_complete\":false},"

        assertTrue(runCatching {
            WatchSnapshotMapper.map(validSnapshot().replace("\"quick_add\":", "$incompleteGoal\"quick_add\":"), 42L)
        }.isFailure)
        assertTrue(runCatching {
            WatchSnapshotMapper.map(validSnapshot().replace("\"quick_add\":", "$invalidProgress\"quick_add\":"), 42L)
        }.isFailure)
    }

    /** Verifies that strict parser rejects duplicate keys and trailing input. */
    @Test
    fun `strict parser rejects duplicate keys and trailing input`() {
        assertTrue(runCatching { StrictJson.parse("{\"a\":1,\"a\":2}") }.isFailure)
        assertTrue(runCatching { StrictJson.parse("{}[]") }.isFailure)
    }

    /** Verifies that fails closed when server plan ownership is absent or unsafe. */
    @Test
    fun `fails closed when server plan ownership is absent or unsafe`() {
        val oldServer = validSnapshot().replace(
            "\"plan\":{\"status\":\"available\",\"reason_code\":null,\"minimum_daily_calorie_target\":1500},",
            ""
        )
        val oldMapped = WatchSnapshotMapper.map(oldServer, 42L).dailySnapshot
        assertEquals("unknown", oldMapped.planStatus)
        assertEquals(null, oldMapped.calorieTarget)
        assertEquals(null, oldMapped.caloriesRemaining)

        val unsafe = validSnapshot()
            .replace("\"status\":\"available\"", "\"status\":\"requires_review\"")
            .replaceFirst("\"reason_code\":null", "\"reason_code\":\"TARGET_BELOW_MINIMUM\"")
            .replace("\"target\":2000,\"remaining\":1250", "\"target\":null,\"remaining\":null")
        val unsafeMapped = WatchSnapshotMapper.map(unsafe, 42L).dailySnapshot
        assertEquals("requires_review", unsafeMapped.planStatus)
        assertEquals("TARGET_BELOW_MINIMUM", unsafeMapped.planReasonCode)
        assertEquals(null, unsafeMapped.calorieTarget)
        assertEquals(null, unsafeMapped.caloriesRemaining)
    }

    /** Verifies that accepts review-only snapshot with sanitized null weights and preserves other state. */
    @Test
    fun `accepts review-only snapshot with sanitized null weights and preserves other state`() {
        val reviewOnly = validSnapshot()
            .replace("\"status\":\"available\"", "\"status\":\"requires_review\"")
            .replaceFirst("\"reason_code\":null", "\"reason_code\":\"WEIGHT_OUT_OF_RANGE\"")
            .replace("\"target\":2000,\"remaining\":1250", "\"target\":null,\"remaining\":null")
            .replace(
                "\"weight\":{\"today_grams\":81500,\"today_revision\":\"abcdef0123456789abcdef01\",\"latest_grams\":81500,\"latest_revision\":\"abcdef0123456789abcdef01\",\"latest_date\":\"2026-07-11\"}",
                "\"weight\":{\"today_grams\":null,\"today_revision\":null,\"latest_grams\":null,\"latest_revision\":null,\"latest_date\":null}"
            )
        val mapped = WatchSnapshotMapper.map(reviewOnly, 42L)

        assertEquals("requires_review", mapped.dailySnapshot.planStatus)
        assertEquals("WEIGHT_OUT_OF_RANGE", mapped.dailySnapshot.planReasonCode)
        assertEquals(null, mapped.dailySnapshot.todayWeightGrams)
        assertEquals(null, mapped.dailySnapshot.latestWeightGrams)
        assertEquals(750, mapped.dailySnapshot.caloriesConsumed)
        assertEquals(1, mapped.quickAddItems.size)
        assertEquals(2, mapped.reminders.size)
    }

    /** Verifies that accepts a server-owned target above one hundred thousand for the room cache. */
    @Test
    fun `accepts a server-owned target above one hundred thousand for the Room cache`() {
        val mapped = WatchSnapshotMapper.map(
            validSnapshot().replace(
                "\"target\":2000,\"remaining\":1250",
                "\"target\":102000,\"remaining\":101250"
            ),
            42L
        ).dailySnapshot

        assertEquals(102_000, mapped.calorieTarget)
        assertEquals(101_250, mapped.caloriesRemaining)
        assertEquals("available", mapped.planStatus)
    }

    /** Verifies that maps paused status and requires food actions and reminders to be absent. */
    @Test
    fun `maps paused status and requires food actions and reminders to be absent`() {
        val paused = validSnapshot()
            .replace(
                "\"food_day\":{\"is_complete\":true,\"completed_at\":\"2026-07-11T01:00:00Z\",\"revision\":\"fedcba9876543210fedcba98\"}",
                "\"food_day\":{\"status\":\"PAUSED\",\"source\":\"PAUSE\",\"is_representative\":false,\"is_complete\":false,\"completed_at\":null,\"revision\":\"fedcba9876543210fedcba98\"}"
            )
            .replace(
                Regex(
                    "\"quick_add\":\\[.*?\\],\\s*\"reminders\"",
                    RegexOption.DOT_MATCHES_ALL
                ),
                "\"quick_add\":[],\"reminders\""
            )
            .replace(
                Regex(
                    "\"reminders\":\\[.*?\\],\\s*\"undo_candidate\"",
                    RegexOption.DOT_MATCHES_ALL
                ),
                "\"reminders\":[],\"undo_candidate\""
            )
        val mapped = WatchSnapshotMapper.map(paused, 42L)

        assertEquals("PAUSED", mapped.dailySnapshot.foodDayStatus)
        assertEquals("PAUSE", mapped.dailySnapshot.foodDaySource)
        assertEquals(false, mapped.dailySnapshot.foodDayRepresentative)
        assertTrue(mapped.quickAddItems.isEmpty())
        assertTrue(mapped.reminders.isEmpty())
    }

    private fun validSnapshot(): String = """
        {
          "server_time":"2026-07-11T01:00:00Z",
          "timezone":"America/Los_Angeles",
          "weight_unit":"LB",
          "revision":"0123456789abcdef01234567",
          "local_date":"2026-07-11",
          "plan":{"status":"available","reason_code":null,"minimum_daily_calorie_target":1500},
          "calories":{"consumed":750,"target":2000,"remaining":1250,"missing":[]},
          "food_day":{"is_complete":true,"completed_at":"2026-07-11T01:00:00Z","revision":"fedcba9876543210fedcba98"},
          "weight":{"today_grams":81500,"today_revision":"abcdef0123456789abcdef01","latest_grams":81500,"latest_revision":"abcdef0123456789abcdef01","latest_date":"2026-07-11"},
          "quick_add":[
            {"id":"my-food:4","source":"pinned","label":"Yogurt","calories":120,"draft":{"date":"2026-07-11","meal_period":"LUNCH","my_food_id":4,"servings_consumed":1}}
          ],
          "reminders":[
            {"id":51,"type":"food","local_date":"2026-07-11","created_at":"2026-07-11T09:00:00Z"},
            {"id":52,"type":"weight","local_date":"2026-07-11","created_at":"2026-07-11T09:00:00Z"}
          ],
          "undo_candidate":{"food_log_id":44,"name":"Yogurt","calories":120,"created_at":"2026-07-11T01:05:00Z"}
        }
    """.trimIndent()
}
