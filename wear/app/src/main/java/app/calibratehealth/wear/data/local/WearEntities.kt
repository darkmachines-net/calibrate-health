/** Room entity shapes, mutation states, and bounded retention policy for watch persistence. */

package app.calibratehealth.wear.data.local

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(tableName = "daily_snapshots")
data class DailySnapshotEntity(
    @PrimaryKey
    @ColumnInfo(name = "local_date")
    val localDate: String,
    @ColumnInfo(name = "calories_consumed")
    val caloriesConsumed: Int? = null,
    @ColumnInfo(name = "calorie_target")
    val calorieTarget: Int? = null,
    @ColumnInfo(name = "calories_remaining")
    val caloriesRemaining: Int? = null,
    @ColumnInfo(name = "plan_status", defaultValue = "'unknown'")
    val planStatus: String = "unknown",
    @ColumnInfo(name = "plan_reason_code")
    val planReasonCode: String? = null,
    @ColumnInfo(name = "minimum_calorie_target")
    val minimumCalorieTarget: Int? = null,
    @ColumnInfo(name = "food_day_complete", defaultValue = "0")
    val foodDayComplete: Boolean = false,
    @ColumnInfo(name = "food_day_status", defaultValue = "'OPEN'")
    val foodDayStatus: String = "OPEN",
    @ColumnInfo(name = "food_day_source")
    val foodDaySource: String? = null,
    @ColumnInfo(name = "food_day_representative", defaultValue = "0")
    val foodDayRepresentative: Boolean = false,
    @ColumnInfo(name = "food_day_completed_at_epoch_ms")
    val foodDayCompletedAtEpochMs: Long? = null,
    @ColumnInfo(name = "food_day_revision")
    val foodDayRevision: String? = null,
    @ColumnInfo(name = "today_weight_grams")
    val todayWeightGrams: Long? = null,
    @ColumnInfo(name = "today_weight_revision")
    val todayWeightRevision: String? = null,
    @ColumnInfo(name = "latest_weight_grams")
    val latestWeightGrams: Long? = null,
    @ColumnInfo(name = "latest_weight_revision")
    val latestWeightRevision: String? = null,
    @ColumnInfo(name = "latest_weight_date")
    val latestWeightDate: String? = null,
    @ColumnInfo(name = "weight_unit", defaultValue = "'KG'")
    val weightUnit: String = "KG",
    @ColumnInfo(name = "goal_start_weight_grams")
    val goalStartWeightGrams: Long? = null,
    @ColumnInfo(name = "goal_target_weight_grams")
    val goalTargetWeightGrams: Long? = null,
    @ColumnInfo(name = "goal_current_weight_grams")
    val goalCurrentWeightGrams: Long? = null,
    @ColumnInfo(name = "goal_daily_deficit")
    val goalDailyDeficit: Int? = null,
    @ColumnInfo(name = "goal_progress_percent")
    val goalProgressPercent: Double? = null,
    @ColumnInfo(name = "goal_remaining_weight_grams")
    val goalRemainingWeightGrams: Long? = null,
    @ColumnInfo(name = "goal_is_complete")
    val goalIsComplete: Boolean? = null,
    @ColumnInfo(name = "goal_projection_status")
    val goalProjectionStatus: String? = null,
    @ColumnInfo(name = "goal_projected_end_date")
    val goalProjectedEndDate: String? = null,
    @ColumnInfo(name = "undo_food_log_id")
    val undoFoodLogId: Long? = null,
    @ColumnInfo(name = "undo_name")
    val undoName: String? = null,
    @ColumnInfo(name = "undo_calories")
    val undoCalories: Int? = null,
    @ColumnInfo(name = "undo_created_at_epoch_ms")
    val undoCreatedAtEpochMs: Long? = null,
    @ColumnInfo(name = "server_revision")
    val serverRevision: String? = null,
    @ColumnInfo(name = "fetched_at_epoch_ms")
    val fetchedAtEpochMs: Long = 0
)

@Entity(
    tableName = "quick_add_items",
    indices = [Index(value = ["sort_rank", "updated_at_epoch_ms"])]
)
data class QuickAddItemEntity(
    @PrimaryKey
    @ColumnInfo(name = "quick_add_id")
    val quickAddId: String,
    val name: String,
    @ColumnInfo(name = "meal_period")
    val mealPeriod: String?,
    val calories: Int,
    @ColumnInfo(name = "serving_description")
    val servingDescription: String,
    @ColumnInfo(name = "mutation_payload_json")
    val mutationPayloadJson: String,
    @ColumnInfo(name = "sort_rank")
    val sortRank: Int,
    @ColumnInfo(name = "updated_at_epoch_ms")
    val updatedAtEpochMs: Long
)

object MutationState {
    const val PENDING = "pending"
    const val AWAITING_SNAPSHOT = "awaiting_snapshot"
    const val SUCCEEDED = "succeeded"
    const val FAILED = "failed"
}

@Entity(
    tableName = "queued_mutations",
    indices = [
        Index(value = ["operation_id"], unique = true),
        Index(value = ["state", "sequence_id"]),
        Index(value = ["state", "attempt_count"])
    ]
)
data class QueuedMutationEntity(
    // Room assigns this row ID at insertion so clock skew and operation IDs cannot reorder the outbox.
    @PrimaryKey(autoGenerate = true)
    @ColumnInfo(name = "sequence_id")
    val sequenceId: Long = 0,
    @ColumnInfo(name = "operation_id")
    val operationId: String,
    @ColumnInfo(name = "mutation_type")
    val mutationType: String,
    @ColumnInfo(name = "payload_json")
    val payloadJson: String,
    @ColumnInfo(name = "created_at_epoch_ms")
    val createdAtEpochMs: Long,
    val state: String = MutationState.PENDING,
    @ColumnInfo(name = "attempt_count")
    val attemptCount: Int = 0,
    @ColumnInfo(name = "last_error")
    val lastError: String? = null
)

@Entity(tableName = "sync_metadata")
data class SyncMetadataEntity(
    @PrimaryKey
    val id: Int = SINGLETON_ID,
    @ColumnInfo(name = "server_origin")
    val serverOrigin: String,
    @ColumnInfo(name = "sync_cursor")
    val syncCursor: String?,
    @ColumnInfo(name = "last_success_at_epoch_ms")
    val lastSuccessAtEpochMs: Long?,
    @ColumnInfo(name = "invalidated_at_epoch_ms")
    val invalidatedAtEpochMs: Long?,
    @ColumnInfo(name = "protocol_version")
    val protocolVersion: Int
) {
    init {
        require(id == SINGLETON_ID) { "Sync metadata must use the singleton row." }
    }

    companion object {
        const val SINGLETON_ID = 1
    }
}

object WearCacheLimits {
    const val DAILY_SNAPSHOTS = 21
    const val QUICK_ADD_ITEMS = 24
    const val TERMINAL_MUTATIONS = 100
}
