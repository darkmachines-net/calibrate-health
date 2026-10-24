/** Room database access and explicit migrations for account-scoped watch persistence. */

package app.calibratehealth.wear.data.local

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(
    entities = [
        DailySnapshotEntity::class,
        QuickAddItemEntity::class,
        QueuedMutationEntity::class,
        SyncMetadataEntity::class
    ],
    version = 7,
    exportSchema = true
)
abstract class CalibrateWearDatabase : RoomDatabase() {
    /** Returns the DAO for bounded daily summary snapshots. */
    abstract fun dailySnapshotDao(): DailySnapshotDao
    /** Returns the DAO for ranked immutable quick-add snapshots. */
    abstract fun quickAddItemDao(): QuickAddItemDao
    /** Returns the DAO for durable mutation ordering and terminal operation records. */
    abstract fun queuedMutationDao(): QueuedMutationDao
    /** Returns the DAO for account-scoped synchronization metadata. */
    abstract fun syncMetadataDao(): SyncMetadataDao

    companion object {
        const val DATABASE_NAME = "calibrate-wear.db"

        @Volatile
        private var instance: CalibrateWearDatabase? = null

        /** Returns the process-shared Room database, opening it once under synchronization. */
        fun get(context: Context): CalibrateWearDatabase = instance ?: synchronized(this) {
            instance ?: open(context).also { instance = it }
        }

        /** Opens the named Room database with every supported explicit migration. */
        fun open(context: Context, name: String = DATABASE_NAME): CalibrateWearDatabase =
            Room.databaseBuilder(
                context.applicationContext,
                CalibrateWearDatabase::class.java,
                name
            )
                .addMigrations(
                    MIGRATION_1_2,
                    MIGRATION_2_3,
                    MIGRATION_3_4,
                    MIGRATION_4_5,
                    MIGRATION_5_6,
                    MIGRATION_6_7
                )
                .build()

        /** Preserves the old outbox order while moving FIFO authority to a database-assigned row ID. */
        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL("ALTER TABLE queued_mutations RENAME TO queued_mutations_v1")
                database.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS queued_mutations (
                        sequence_id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
                        operation_id TEXT NOT NULL,
                        mutation_type TEXT NOT NULL,
                        payload_json TEXT NOT NULL,
                        created_at_epoch_ms INTEGER NOT NULL,
                        state TEXT NOT NULL,
                        attempt_count INTEGER NOT NULL,
                        last_error TEXT
                    )
                    """.trimIndent()
                )
                database.execSQL(
                    """
                    INSERT INTO queued_mutations (
                        operation_id, mutation_type, payload_json, created_at_epoch_ms,
                        state, attempt_count, last_error
                    )
                    SELECT operation_id, mutation_type, payload_json, created_at_epoch_ms,
                        state, attempt_count, last_error
                    FROM queued_mutations_v1
                    ORDER BY created_at_epoch_ms ASC, operation_id ASC
                    """.trimIndent()
                )
                database.execSQL("DROP TABLE queued_mutations_v1")
                database.execSQL(
                    "CREATE UNIQUE INDEX IF NOT EXISTS index_queued_mutations_operation_id " +
                        "ON queued_mutations (operation_id)"
                )
                database.execSQL(
                    "CREATE INDEX IF NOT EXISTS index_queued_mutations_state_sequence_id " +
                        "ON queued_mutations (state, sequence_id)"
                )
                database.execSQL(
                    "CREATE INDEX IF NOT EXISTS index_queued_mutations_state_attempt_count " +
                        "ON queued_mutations (state, attempt_count)"
                )
            }
        }

        /** Expands the cached daily row without inventing activity, weight, or undo data for v2 caches. */
        val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL("ALTER TABLE daily_snapshots ADD COLUMN calories_remaining INTEGER")
                database.execSQL("ALTER TABLE daily_snapshots ADD COLUMN activity_total_calories INTEGER")
                database.execSQL("ALTER TABLE daily_snapshots ADD COLUMN exercise_minutes INTEGER")
                database.execSQL("ALTER TABLE daily_snapshots ADD COLUMN activity_observed_at_epoch_ms INTEGER")
                database.execSQL("ALTER TABLE daily_snapshots ADD COLUMN activity_stale INTEGER NOT NULL DEFAULT 1")
                database.execSQL("ALTER TABLE daily_snapshots ADD COLUMN activity_age_seconds INTEGER")
                database.execSQL("ALTER TABLE daily_snapshots ADD COLUMN food_day_complete INTEGER NOT NULL DEFAULT 0")
                database.execSQL("ALTER TABLE daily_snapshots ADD COLUMN food_day_completed_at_epoch_ms INTEGER")
                database.execSQL("ALTER TABLE daily_snapshots ADD COLUMN food_day_revision TEXT")
                database.execSQL("ALTER TABLE daily_snapshots ADD COLUMN today_weight_grams INTEGER")
                database.execSQL("ALTER TABLE daily_snapshots ADD COLUMN today_weight_revision TEXT")
                database.execSQL("ALTER TABLE daily_snapshots ADD COLUMN latest_weight_revision TEXT")
                database.execSQL("ALTER TABLE daily_snapshots ADD COLUMN latest_weight_date TEXT")
                database.execSQL("ALTER TABLE daily_snapshots ADD COLUMN weight_unit TEXT NOT NULL DEFAULT 'KG'")
                database.execSQL("ALTER TABLE daily_snapshots ADD COLUMN undo_food_log_id INTEGER")
                database.execSQL("ALTER TABLE daily_snapshots ADD COLUMN undo_name TEXT")
                database.execSQL("ALTER TABLE daily_snapshots ADD COLUMN undo_calories INTEGER")
                database.execSQL("ALTER TABLE daily_snapshots ADD COLUMN undo_created_at_epoch_ms INTEGER")
            }
        }

        /** Adds nullable goal progress so existing cached summaries remain valid after upgrade. */
        val MIGRATION_3_4 = object : Migration(3, 4) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL("ALTER TABLE daily_snapshots ADD COLUMN goal_start_weight_grams INTEGER")
                database.execSQL("ALTER TABLE daily_snapshots ADD COLUMN goal_target_weight_grams INTEGER")
                database.execSQL("ALTER TABLE daily_snapshots ADD COLUMN goal_current_weight_grams INTEGER")
                database.execSQL("ALTER TABLE daily_snapshots ADD COLUMN goal_daily_deficit INTEGER")
                database.execSQL("ALTER TABLE daily_snapshots ADD COLUMN goal_progress_percent REAL")
                database.execSQL("ALTER TABLE daily_snapshots ADD COLUMN goal_remaining_weight_grams INTEGER")
                database.execSQL("ALTER TABLE daily_snapshots ADD COLUMN goal_is_complete INTEGER")
            }
        }

        /** Drops activity cache fields after the 0.2 Watch contract stopped mirroring activity. */
        val MIGRATION_4_5 = object : Migration(4, 5) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL(
                    """
                    CREATE TABLE daily_snapshots_v5 (
                        local_date TEXT NOT NULL PRIMARY KEY,
                        calories_consumed INTEGER,
                        calorie_target INTEGER,
                        calories_remaining INTEGER,
                        food_day_complete INTEGER NOT NULL DEFAULT 0,
                        food_day_completed_at_epoch_ms INTEGER,
                        food_day_revision TEXT,
                        today_weight_grams INTEGER,
                        today_weight_revision TEXT,
                        latest_weight_grams INTEGER,
                        latest_weight_revision TEXT,
                        latest_weight_date TEXT,
                        weight_unit TEXT NOT NULL DEFAULT 'KG',
                        goal_start_weight_grams INTEGER,
                        goal_target_weight_grams INTEGER,
                        goal_current_weight_grams INTEGER,
                        goal_daily_deficit INTEGER,
                        goal_progress_percent REAL,
                        goal_remaining_weight_grams INTEGER,
                        goal_is_complete INTEGER,
                        undo_food_log_id INTEGER,
                        undo_name TEXT,
                        undo_calories INTEGER,
                        undo_created_at_epoch_ms INTEGER,
                        server_revision TEXT,
                        fetched_at_epoch_ms INTEGER NOT NULL
                    )
                    """.trimIndent()
                )
                database.execSQL(
                    """
                    INSERT INTO daily_snapshots_v5 (
                        local_date, calories_consumed, calorie_target, calories_remaining,
                        food_day_complete, food_day_completed_at_epoch_ms, food_day_revision,
                        today_weight_grams, today_weight_revision, latest_weight_grams,
                        latest_weight_revision, latest_weight_date, weight_unit,
                        goal_start_weight_grams, goal_target_weight_grams, goal_current_weight_grams,
                        goal_daily_deficit, goal_progress_percent, goal_remaining_weight_grams, goal_is_complete,
                        undo_food_log_id, undo_name, undo_calories, undo_created_at_epoch_ms,
                        server_revision, fetched_at_epoch_ms
                    )
                    SELECT
                        local_date, calories_consumed, calorie_target, calories_remaining,
                        food_day_complete, food_day_completed_at_epoch_ms, food_day_revision,
                        today_weight_grams, today_weight_revision, latest_weight_grams,
                        latest_weight_revision, latest_weight_date, weight_unit,
                        goal_start_weight_grams, goal_target_weight_grams, goal_current_weight_grams,
                        goal_daily_deficit, goal_progress_percent, goal_remaining_weight_grams, goal_is_complete,
                        undo_food_log_id, undo_name, undo_calories, undo_created_at_epoch_ms,
                        server_revision, fetched_at_epoch_ms
                    FROM daily_snapshots
                    """.trimIndent()
                )
                database.execSQL("DROP TABLE daily_snapshots")
                database.execSQL("ALTER TABLE daily_snapshots_v5 RENAME TO daily_snapshots")
            }
        }

        /** Adds the effective food-day resolution while retaining the legacy completion cache. */
        val MIGRATION_5_6 = object : Migration(5, 6) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL(
                    "ALTER TABLE daily_snapshots ADD COLUMN food_day_status TEXT NOT NULL DEFAULT 'OPEN'"
                )
                database.execSQL("ALTER TABLE daily_snapshots ADD COLUMN food_day_source TEXT")
                database.execSQL(
                    "ALTER TABLE daily_snapshots ADD COLUMN food_day_representative INTEGER NOT NULL DEFAULT 0"
                )
                database.execSQL(
                    """
                    UPDATE daily_snapshots
                    SET food_day_status = CASE WHEN food_day_complete = 1 THEN 'COMPLETE' ELSE 'OPEN' END,
                        food_day_representative = food_day_complete
                    """.trimIndent()
                )
            }
        }

        /** Makes server-owned calorie-plan availability authoritative for every cached surface. */
        val MIGRATION_6_7 = object : Migration(6, 7) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL(
                    "ALTER TABLE daily_snapshots ADD COLUMN plan_status TEXT NOT NULL DEFAULT 'unknown'"
                )
                database.execSQL("ALTER TABLE daily_snapshots ADD COLUMN plan_reason_code TEXT")
                database.execSQL("ALTER TABLE daily_snapshots ADD COLUMN minimum_calorie_target INTEGER")
                database.execSQL("ALTER TABLE daily_snapshots ADD COLUMN goal_projection_status TEXT")
                database.execSQL("ALTER TABLE daily_snapshots ADD COLUMN goal_projected_end_date TEXT")
                database.execSQL(
                    "UPDATE daily_snapshots SET calorie_target = NULL, calories_remaining = NULL"
                )
            }
        }
    }
}
