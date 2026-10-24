/** Regression tests and fixtures for Wear Persistence Instrumented. */

package app.calibratehealth.wear.data

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.sqlite.db.SupportSQLiteOpenHelper
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory
import app.calibratehealth.wear.R
import app.calibratehealth.wear.WearDataLayerContract
import app.calibratehealth.wear.data.local.CalibrateWearDatabase
import app.calibratehealth.wear.data.local.DailySnapshotEntity
import app.calibratehealth.wear.data.local.QueuedMutationEntity
import app.calibratehealth.wear.data.local.QuickAddItemEntity
import app.calibratehealth.wear.data.local.SyncMetadataEntity
import app.calibratehealth.wear.data.security.AndroidKeystoreTokenStore
import app.calibratehealth.wear.data.security.RoomAccountDataStore
import app.calibratehealth.wear.data.security.SecureSession
import app.calibratehealth.wear.data.security.SecureTokenCorruptedException
import java.security.KeyStore
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WearPersistenceInstrumentedTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val databaseName = "wear-persistence-test.db"
    private val migrationDatabaseName = "wear-migration-test.db"
    private val preferencesName = "wear-secure-session-test"
    private val keyAlias = "calibrate_wear_session_test"

    /** Closes owned stores and removes test account state after each instrumentation scenario. */
    @After
    fun cleanUp() {
        context.deleteDatabase(databaseName)
        context.deleteDatabase(migrationDatabaseName)
        context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit().clear().commit()
        KeyStore.getInstance("AndroidKeyStore").apply {
            load(null)
            if (containsAlias(keyAlias)) deleteEntry(keyAlias)
        }
    }

    /** Verifies that room state survives database reopen and keeps fifo order. */
    @Test
    fun roomStateSurvivesDatabaseReopenAndKeepsFifoOrder() = runBlocking {
        var database = CalibrateWearDatabase.open(context, databaseName)
        database.dailySnapshotDao().cacheBounded(snapshot("2026-07-09"), maxRows = 2)
        database.dailySnapshotDao().cacheBounded(snapshot("2026-07-11"), maxRows = 2)
        database.dailySnapshotDao().cacheBounded(snapshot("2026-07-10"), maxRows = 2)
        database.quickAddItemDao().cacheBounded(
            listOf(quickAdd("third", 3), quickAdd("first", 1), quickAdd("second", 2)),
            maxRows = 2
        )
        database.queuedMutationDao().insert(mutation("b", 100))
        database.queuedMutationDao().insert(mutation("a", 100))
        database.syncMetadataDao().upsert(
            SyncMetadataEntity(
                serverOrigin = "https://health.example.com",
                syncCursor = "cursor-1",
                lastSuccessAtEpochMs = 123,
                invalidatedAtEpochMs = null,
                protocolVersion = 1
            )
        )
        database.close()

        database = CalibrateWearDatabase.open(context, databaseName)
        assertEquals(
            listOf("2026-07-11", "2026-07-10"),
            database.dailySnapshotDao().allNewestFirst().map { it.localDate }
        )
        val latest = database.dailySnapshotDao().allNewestFirst().first()
        assertEquals(1250, latest.caloriesRemaining)
        assertEquals(true, latest.foodDayComplete)
        assertEquals("food-day-revision", latest.foodDayRevision)
        assertEquals(81_500L, latest.todayWeightGrams)
        assertEquals("today-weight-revision", latest.todayWeightRevision)
        assertEquals("latest-weight-revision", latest.latestWeightRevision)
        assertEquals("2026-07-11", latest.latestWeightDate)
        assertEquals("LB", latest.weightUnit)
        assertEquals(44L, latest.undoFoodLogId)
        assertEquals("Yogurt", latest.undoName)
        assertEquals(120, latest.undoCalories)
        assertEquals(125_000L, latest.undoCreatedAtEpochMs)
        assertEquals(listOf("b", "a"), database.queuedMutationDao().pendingInFifoOrder().map { it.operationId })
        assertEquals(listOf("first", "second"), database.quickAddItemDao().all().map { it.quickAddId })
        assertEquals(1, database.queuedMutationDao().markRetry("b", "offline"))
        assertEquals(1, database.queuedMutationDao().head()?.attemptCount)
        assertEquals(1, database.queuedMutationDao().markServerSucceeded("b"))
        assertEquals(listOf("b", "a"), database.queuedMutationDao().activeInFifoOrder().map { it.operationId })
        assertEquals(1, database.queuedMutationDao().confirmSnapshotRefresh())
        assertEquals(listOf("a"), database.queuedMutationDao().activeInFifoOrder().map { it.operationId })
        assertEquals("cursor-1", database.syncMetadataDao().get()?.syncCursor)
        database.close()
    }

    /** Verifies that keystore session survives store recreation. */
    @Test
    fun keystoreSessionSurvivesStoreRecreation() {
        val session = SecureSession(
            accessToken = "secret-access-token",
            refreshToken = "secret-refresh-token",
            userId = 1,
            serverOrigin = "https://health.example.com",
            watchDeviceId = "watch-1",
            accessExpiresAtEpochMs = 123_456,
            refreshExpiresAtEpochMs = 223_456
        )
        AndroidKeystoreTokenStore(context, keyAlias, preferencesName, session.serverOrigin).write(session)
        val reopened = AndroidKeystoreTokenStore(context, keyAlias, preferencesName, session.serverOrigin)
        assertEquals(session, reopened.read())
        assertThrows(SecureTokenCorruptedException::class.java) {
            AndroidKeystoreTokenStore(
                context,
                keyAlias,
                preferencesName,
                "https://other.example.com"
            ).read()
        }
        reopened.clear()
        assertNull(reopened.read())
    }

    /** Verifies that database can be created with all daos. */
    @Test
    fun databaseCanBeCreatedWithAllDaos() {
        val database = CalibrateWearDatabase.open(context, databaseName)
        assertNotNull(database.dailySnapshotDao())
        assertNotNull(database.quickAddItemDao())
        assertNotNull(database.queuedMutationDao())
        assertNotNull(database.syncMetadataDao())
        database.close()
    }

    /** Verifies that version two snapshot migration uses fail safe defaults. */
    @Test
    fun versionTwoSnapshotMigrationUsesFailSafeDefaults() {
        val configuration = SupportSQLiteOpenHelper.Configuration.builder(context)
            .name(migrationDatabaseName)
            .callback(object : SupportSQLiteOpenHelper.Callback(2) {
                override fun onCreate(database: SupportSQLiteDatabase) {
                    database.execSQL(
                        """
                        CREATE TABLE daily_snapshots (
                            local_date TEXT NOT NULL PRIMARY KEY,
                            calories_consumed INTEGER,
                            calorie_target INTEGER,
                            steps INTEGER,
                            activity_calories INTEGER,
                            latest_weight_grams INTEGER,
                            server_revision TEXT,
                            fetched_at_epoch_ms INTEGER NOT NULL
                        )
                        """.trimIndent()
                    )
                    database.execSQL(
                        "INSERT INTO daily_snapshots (local_date, calories_consumed, fetched_at_epoch_ms) " +
                            "VALUES ('2026-07-11', 750, 42)"
                    )
                }

                override fun onUpgrade(database: SupportSQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
            })
            .build()
        val helper = FrameworkSQLiteOpenHelperFactory().create(configuration)
        val database = helper.writableDatabase

        CalibrateWearDatabase.MIGRATION_2_3.migrate(database)

        database.query("SELECT * FROM daily_snapshots WHERE local_date = '2026-07-11'").use { cursor ->
            assertEquals(true, cursor.moveToFirst())
            assertEquals(1, cursor.getInt(cursor.getColumnIndexOrThrow("activity_stale")))
            assertEquals(0, cursor.getInt(cursor.getColumnIndexOrThrow("food_day_complete")))
            assertEquals("KG", cursor.getString(cursor.getColumnIndexOrThrow("weight_unit")))
            assertEquals(true, cursor.isNull(cursor.getColumnIndexOrThrow("today_weight_grams")))
            assertEquals(true, cursor.isNull(cursor.getColumnIndexOrThrow("undo_food_log_id")))
        }
        helper.close()
    }

    /** Verifies that version three goal migration preserves snapshots with no invented progress. */
    @Test
    fun versionThreeGoalMigrationPreservesSnapshotsWithNoInventedProgress() {
        val configuration = SupportSQLiteOpenHelper.Configuration.builder(context)
            .name(migrationDatabaseName)
            .callback(object : SupportSQLiteOpenHelper.Callback(3) {
                override fun onCreate(database: SupportSQLiteDatabase) {
                    database.execSQL(
                        "CREATE TABLE daily_snapshots (local_date TEXT NOT NULL PRIMARY KEY, fetched_at_epoch_ms INTEGER NOT NULL)"
                    )
                    database.execSQL(
                        "INSERT INTO daily_snapshots (local_date, fetched_at_epoch_ms) VALUES ('2026-07-11', 42)"
                    )
                }

                override fun onUpgrade(database: SupportSQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
            })
            .build()
        val helper = FrameworkSQLiteOpenHelperFactory().create(configuration)
        val database = helper.writableDatabase

        CalibrateWearDatabase.MIGRATION_3_4.migrate(database)

        database.query("SELECT * FROM daily_snapshots WHERE local_date = '2026-07-11'").use { cursor ->
            assertEquals(true, cursor.moveToFirst())
            assertEquals(true, cursor.isNull(cursor.getColumnIndexOrThrow("goal_start_weight_grams")))
            assertEquals(true, cursor.isNull(cursor.getColumnIndexOrThrow("goal_progress_percent")))
            assertEquals(true, cursor.isNull(cursor.getColumnIndexOrThrow("goal_is_complete")))
        }
        helper.close()
    }

    /** Verifies that version four migration drops activity cache and preserves summary data. */
    @Test
    fun versionFourMigrationDropsActivityCacheAndPreservesSummaryData() {
        val configuration = SupportSQLiteOpenHelper.Configuration.builder(context)
            .name(migrationDatabaseName)
            .callback(object : SupportSQLiteOpenHelper.Callback(4) {
                override fun onCreate(database: SupportSQLiteDatabase) {
                    database.execSQL(
                        """
                        CREATE TABLE daily_snapshots (
                            local_date TEXT NOT NULL PRIMARY KEY,
                            calories_consumed INTEGER, calorie_target INTEGER, calories_remaining INTEGER,
                            steps INTEGER, activity_calories INTEGER, activity_total_calories INTEGER,
                            exercise_minutes INTEGER, activity_observed_at_epoch_ms INTEGER,
                            activity_stale INTEGER NOT NULL DEFAULT 1, activity_age_seconds INTEGER,
                            food_day_complete INTEGER NOT NULL DEFAULT 0, food_day_completed_at_epoch_ms INTEGER,
                            food_day_revision TEXT, today_weight_grams INTEGER, today_weight_revision TEXT,
                            latest_weight_grams INTEGER, latest_weight_revision TEXT, latest_weight_date TEXT,
                            weight_unit TEXT NOT NULL DEFAULT 'KG', goal_start_weight_grams INTEGER,
                            goal_target_weight_grams INTEGER, goal_current_weight_grams INTEGER,
                            goal_daily_deficit INTEGER, goal_progress_percent REAL,
                            goal_remaining_weight_grams INTEGER, goal_is_complete INTEGER,
                            undo_food_log_id INTEGER, undo_name TEXT, undo_calories INTEGER,
                            undo_created_at_epoch_ms INTEGER, server_revision TEXT,
                            fetched_at_epoch_ms INTEGER NOT NULL
                        )
                        """.trimIndent()
                    )
                    database.execSQL(
                        """
                        INSERT INTO daily_snapshots (
                            local_date, calories_consumed, calories_remaining, activity_stale,
                            food_day_complete, weight_unit, goal_progress_percent, fetched_at_epoch_ms
                        ) VALUES ('2026-07-11', 750, 1250, 0, 1, 'LB', 42.5, 99)
                        """.trimIndent()
                    )
                }

                override fun onUpgrade(database: SupportSQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
            })
            .build()
        val helper = FrameworkSQLiteOpenHelperFactory().create(configuration)
        val database = helper.writableDatabase

        CalibrateWearDatabase.MIGRATION_4_5.migrate(database)

        database.query("SELECT calories_consumed, calories_remaining, food_day_complete, weight_unit, goal_progress_percent, fetched_at_epoch_ms FROM daily_snapshots").use { cursor ->
            assertEquals(true, cursor.moveToFirst())
            assertEquals(750, cursor.getInt(0))
            assertEquals(1250, cursor.getInt(1))
            assertEquals(1, cursor.getInt(2))
            assertEquals("LB", cursor.getString(3))
            assertEquals(42.5, cursor.getDouble(4), 0.0)
            assertEquals(99, cursor.getLong(5))
        }
        database.query("PRAGMA table_info(daily_snapshots)").use { cursor ->
            val columns = mutableSetOf<String>()
            val nameColumn = cursor.getColumnIndexOrThrow("name")
            while (cursor.moveToNext()) columns += cursor.getString(nameColumn)
            assertEquals(false, columns.contains("activity_stale"))
            assertEquals(false, columns.contains("activity_total_calories"))
        }
        helper.close()
    }

    /** Verifies that version five migration backfills day resolution from legacy completion. */
    @Test
    fun versionFiveMigrationBackfillsDayResolutionFromLegacyCompletion() {
        val configuration = SupportSQLiteOpenHelper.Configuration.builder(context)
            .name(migrationDatabaseName)
            .callback(object : SupportSQLiteOpenHelper.Callback(5) {
                override fun onCreate(database: SupportSQLiteDatabase) {
                    database.execSQL(
                        """
                        CREATE TABLE daily_snapshots (
                            local_date TEXT NOT NULL PRIMARY KEY,
                            food_day_complete INTEGER NOT NULL DEFAULT 0
                        )
                        """.trimIndent()
                    )
                    database.execSQL(
                        """
                        INSERT INTO daily_snapshots (local_date, food_day_complete)
                        VALUES ('2026-07-11', 1), ('2026-07-12', 0)
                        """.trimIndent()
                    )
                }

                override fun onUpgrade(database: SupportSQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
            })
            .build()
        val helper = FrameworkSQLiteOpenHelperFactory().create(configuration)
        val database = helper.writableDatabase

        CalibrateWearDatabase.MIGRATION_5_6.migrate(database)

        database.query(
            """
            SELECT local_date, food_day_status, food_day_source, food_day_representative
            FROM daily_snapshots
            ORDER BY local_date
            """.trimIndent()
        ).use { cursor ->
            assertEquals(true, cursor.moveToFirst())
            assertEquals("COMPLETE", cursor.getString(1))
            assertEquals(true, cursor.isNull(2))
            assertEquals(1, cursor.getInt(3))

            assertEquals(true, cursor.moveToNext())
            assertEquals("OPEN", cursor.getString(1))
            assertEquals(true, cursor.isNull(2))
            assertEquals(0, cursor.getInt(3))
        }
        helper.close()
    }

    /** Verifies that version six migration fails closed for cached calorie targets. */
    @Test
    fun versionSixMigrationFailsClosedForCachedCalorieTargets() {
        val configuration = SupportSQLiteOpenHelper.Configuration.builder(context)
            .name(migrationDatabaseName)
            .callback(object : SupportSQLiteOpenHelper.Callback(6) {
                override fun onCreate(database: SupportSQLiteDatabase) {
                    database.execSQL(
                        """
                        CREATE TABLE daily_snapshots (
                            local_date TEXT NOT NULL PRIMARY KEY,
                            calorie_target INTEGER,
                            calories_remaining INTEGER
                        )
                        """.trimIndent()
                    )
                    database.execSQL(
                        """
                        INSERT INTO daily_snapshots (local_date, calorie_target, calories_remaining)
                        VALUES ('2026-08-08', 2100, 450)
                        """.trimIndent()
                    )
                }

                override fun onUpgrade(database: SupportSQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
            })
            .build()
        val helper = FrameworkSQLiteOpenHelperFactory().create(configuration)
        val database = helper.writableDatabase

        CalibrateWearDatabase.MIGRATION_6_7.migrate(database)

        database.query(
            """
            SELECT plan_status, plan_reason_code, minimum_calorie_target,
                goal_projection_status, goal_projected_end_date,
                calorie_target, calories_remaining
            FROM daily_snapshots
            """.trimIndent()
        ).use { cursor ->
            assertEquals(true, cursor.moveToFirst())
            assertEquals("unknown", cursor.getString(0))
            for (column in 1..6) assertEquals(true, cursor.isNull(column))
        }
        helper.close()
    }

    /** Verifies that room account data store clears every account scoped table. */
    @Test
    fun roomAccountDataStoreClearsEveryAccountScopedTable() = runBlocking {
        val database = CalibrateWearDatabase.open(context, databaseName)
        database.dailySnapshotDao().cacheBounded(snapshot("2026-07-11"), maxRows = 2)
        database.quickAddItemDao().cacheBounded(listOf(quickAdd("food-1", 1)), maxRows = 2)
        database.queuedMutationDao().insert(mutation("operation-1", 100))
        database.queuedMutationDao().markServerSucceeded("operation-1")
        database.syncMetadataDao().upsert(
            SyncMetadataEntity(
                serverOrigin = "https://health.example.com",
                syncCursor = "cursor-1",
                lastSuccessAtEpochMs = 123,
                invalidatedAtEpochMs = null,
                protocolVersion = 1
            )
        )

        RoomAccountDataStore(database).clearAll()

        assertEquals(emptyList<DailySnapshotEntity>(), database.dailySnapshotDao().allNewestFirst())
        assertEquals(emptyList<QuickAddItemEntity>(), database.quickAddItemDao().all())
        assertEquals(emptyList<QueuedMutationEntity>(), database.queuedMutationDao().activeInFifoOrder())
        assertNull(database.queuedMutationDao().latestTerminal())
        assertNull(database.syncMetadataDao().get())
        database.close()
    }

    /** Verifies that published pairing capability matches contract. */
    @Test
    fun publishedPairingCapabilityMatchesContract() {
        val capabilities = context.resources.getStringArray(R.array.android_wear_capabilities)
        assertEquals(listOf(WearDataLayerContract.PAIRING_CAPABILITY), capabilities.toList())
    }

    private fun snapshot(localDate: String) = DailySnapshotEntity(
        localDate = localDate,
        caloriesConsumed = 750,
        calorieTarget = 2_000,
        caloriesRemaining = 1_250,
        foodDayComplete = true,
        foodDayCompletedAtEpochMs = 124_000,
        foodDayRevision = "food-day-revision",
        todayWeightGrams = 81_500,
        todayWeightRevision = "today-weight-revision",
        latestWeightGrams = 81_500,
        latestWeightRevision = "latest-weight-revision",
        latestWeightDate = localDate,
        weightUnit = "LB",
        undoFoodLogId = 44,
        undoName = "Yogurt",
        undoCalories = 120,
        undoCreatedAtEpochMs = 125_000,
        serverRevision = "server-revision",
        fetchedAtEpochMs = 126_000
    )

    private fun mutation(id: String, createdAt: Long) = QueuedMutationEntity(
        operationId = id,
        mutationType = "food.create",
        payloadJson = "{}",
        createdAtEpochMs = createdAt
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
}
