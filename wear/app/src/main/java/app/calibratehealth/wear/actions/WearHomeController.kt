/** Watch action planning, durable mutation enqueueing, and user-facing queue/recovery state. */

package app.calibratehealth.wear.actions

import app.calibratehealth.wear.WearSummary
import app.calibratehealth.wear.WearSyncStatus
import app.calibratehealth.wear.data.DailySnapshotRepository
import app.calibratehealth.wear.data.MutationOutboxRepository
import app.calibratehealth.wear.data.QuickAddRepository
import app.calibratehealth.wear.data.SyncMetadataRepository
import app.calibratehealth.wear.data.local.DailySnapshotEntity
import app.calibratehealth.wear.data.local.MutationState
import app.calibratehealth.wear.data.local.QueuedMutationEntity
import app.calibratehealth.wear.data.local.QuickAddItemEntity
import app.calibratehealth.wear.sync.QueuedMutationFactory
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class WearHomeUiState(
    val summary: WearSummary? = null,
    val quickAdds: List<QuickAddItemEntity> = emptyList(),
    val syncStatus: WearSyncStatus = WearSyncStatus.Idle,
    val actionInProgress: Boolean = false,
    val pendingMutationTypes: Set<String> = emptySet()
)

data class PlannedMutation(val type: String, val payloadJson: String)

/** Pure mutation planner centralizes the exact, optimistic Watch API wire contract. */
object WearActionPlanner {
    /** Plans a food creation from the immutable quick-add snapshot payload. */
    fun quickAdd(item: QuickAddItemEntity): PlannedMutation =
        PlannedMutation("food.create", item.mutationPayloadJson)

    /** Plans a day-completion toggle with the snapshot revision required for conflict detection. */
    fun setFoodDayComplete(summary: WearSummary): PlannedMutation = PlannedMutation(
        "food_day.set_complete",
        jsonObject(
            "local_date" to jsonString(summary.localDate),
            "is_complete" to (!summary.foodDayComplete).toString(),
            "expected_revision" to nullableJsonString(summary.foodDayRevision)
        )
    )

    /** Plans deletion of the currently eligible undo candidate, otherwise returns null. */
    fun undo(summary: WearSummary): PlannedMutation? = summary.undoFoodLogId?.takeIf { summary.hasUndoCandidate }?.let {
        PlannedMutation("food.delete", jsonObject("food_log_id" to it.toString()))
    }

    /** Validates canonical weight grams and plans an upsert with the current local-day revision. */
    fun saveWeight(summary: WearSummary, grams: Long): PlannedMutation {
        require(grams in 25_000L..400_000L) { "Weight must be between 25 and 400 kg." }
        return PlannedMutation(
            "metric.upsert",
            jsonObject(
                "local_date" to jsonString(summary.localDate),
                "weight_grams" to grams.toString(),
                "expected_revision" to nullableJsonString(summary.todayWeightRevision)
            )
        )
    }

    private fun jsonObject(vararg fields: Pair<String, String>): String = fields.joinToString(
        prefix = "{",
        postfix = "}",
        separator = ","
    ) { (key, value) -> "${jsonString(key)}:$value" }

    private fun nullableJsonString(value: String?): String = value?.let(::jsonString) ?: "null"

    private fun jsonString(value: String): String = buildString {
        append('"')
        value.forEach { character ->
            when (character) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\b' -> append("\\b")
                '\u000c' -> append("\\f")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> if (character.code < 0x20) append("\\u%04x".format(character.code)) else append(character)
            }
        }
        append('"')
    }
}

/** Connects Room-backed cache flows to durable, WorkManager-scheduled fast actions. */
class WearHomeController(
    snapshots: DailySnapshotRepository,
    quickAdds: QuickAddRepository,
    metadata: SyncMetadataRepository,
    private val outbox: MutationOutboxRepository,
    private val mutationFactory: QueuedMutationFactory,
    private val continueOnPhone: ContinueOnPhoneMessenger,
    private val refreshCalorieGlance: () -> Unit = {},
    private val scope: CoroutineScope
) {
    private val actionState = MutableStateFlow(ActionState())

    val uiState: StateFlow<WearHomeUiState> = combine(
        snapshots.observeLatest(),
        quickAdds.observeAll(),
        metadata.observe(),
        actionState
    ) { snapshot, items, syncMetadata, action ->
        WearHomeUiState(
            summary = snapshot?.toWearSummary(syncMetadata?.lastSuccessAtEpochMs),
            quickAdds = items,
            syncStatus = action.status,
            actionInProgress = action.inProgress,
            pendingMutationTypes = action.pendingMutationTypes
        )
    }.stateIn(scope, SharingStarted.Eagerly, WearHomeUiState())

    init {
        refreshQueueStatus()
    }

    /** Enqueues the selected quick-add snapshot for durable idempotent synchronization. */
    fun quickAdd(item: QuickAddItemEntity) = enqueue(WearActionPlanner.quickAdd(item))

    /** Enqueues a revision-bound completion toggle for the displayed food day. */
    fun toggleFoodDay(summary: WearSummary) = enqueue(WearActionPlanner.setFoodDayComplete(summary))

    /** Enqueues deletion of the eligible undo candidate or presents an unavailable-action error. */
    fun undo(summary: WearSummary) {
        val planned = WearActionPlanner.undo(summary)
        if (planned == null) {
            setActionError("Undo is no longer available.")
        } else {
            enqueue(planned)
        }
    }

    /** Validates a weight action before enqueueing it, presenting validation failures to the user. */
    fun saveWeight(summary: WearSummary, grams: Long) {
        val planned = runCatching { WearActionPlanner.saveWeight(summary, grams) }
            .getOrElse { error ->
                setActionError(error.message ?: "Weight could not be saved.")
                return
            }
        enqueue(planned)
    }

    /** Requests the dated food-log handoff while preventing overlapping actions and reporting unreachable phone state. */
    fun continueOnPhone(summary: WearSummary) {
        if (actionState.value.inProgress) return
        actionState.value = actionState.value.copy(inProgress = true)
        continueOnPhone.send(ContinueOnPhoneRequest.FoodLog(summary.localDate)) { result ->
            scope.launch {
                if (result.isSuccess) {
                    actionState.update { current -> current.copy(inProgress = false) }
                    refreshQueueStatus()
                } else {
                    setActionError("Phone is not reachable.")
                }
            }
        }
    }

    /** Updates visible sync status when background work requires attention. */
    fun reportWorkerFailure(message: String = "Health sync needs attention.") {
        actionState.update { current ->
            current.copy(status = WearSyncStatus.Error(message))
        }
    }

    /** Reloads active and terminal outbox state to reconcile the action status shown on the watch. */
    fun refreshQueueStatus() {
        scope.launch {
            val queueState = runCatching {
                outbox.activeInFifoOrder() to outbox.latestTerminal()
            }.getOrElse {
                actionState.update { current ->
                    current.copy(status = WearSyncStatus.Error("Pending changes are unavailable."))
                }
                return@launch
            }
            val (pending, latestTerminal) = queueState
            actionState.update { current ->
                current.copy(
                    status = queueStatus(pending, latestTerminal),
                    pendingMutationTypes = pending.mapTo(mutableSetOf()) { it.mutationType }
                )
            }
        }
    }

    private fun enqueue(planned: PlannedMutation) {
        if (actionState.value.inProgress) return
        actionState.value = actionState.value.copy(inProgress = true)
        scope.launch {
            val queued = runCatching {
                outbox.enqueue(mutationFactory.create(planned.type, planned.payloadJson))
            }.getOrElse {
                setActionError("Change could not be queued.")
                return@launch
            }
            if (!queued) {
                setActionError("Change was already queued.")
                return@launch
            }
            if (planned.type == "metric.upsert") refreshCalorieGlance()
            val pending = runCatching { outbox.activeInFifoOrder() }.getOrElse {
                actionState.update { current ->
                    current.copy(
                        status = WearSyncStatus.Error("Change queued, but queue status is unavailable."),
                        inProgress = false,
                        pendingMutationTypes = current.pendingMutationTypes + planned.type
                    )
                }
                return@launch
            }
            actionState.value = ActionState(
                status = WearSyncStatus.Pending(pending.size.coerceAtLeast(1)),
                pendingMutationTypes = pending.mapTo(mutableSetOf()) { it.mutationType } + planned.type
            )
        }
    }



    private fun setActionError(message: String) {
        actionState.update { current ->
            current.copy(status = WearSyncStatus.Error(message), inProgress = false)
        }
    }
}

/** Resolves durable queue state so worker failures remain visible after the process restarts. */
internal fun queueStatus(
    pending: List<QueuedMutationEntity>,
    latestTerminal: QueuedMutationEntity?
): WearSyncStatus = when {
    pending.isNotEmpty() -> WearSyncStatus.Pending(pending.size)
    latestTerminal?.state == MutationState.FAILED -> WearSyncStatus.Error(
        latestTerminal.lastError?.takeIf { it.isNotBlank() }
            ?: "The last watch change needs attention."
    )
    else -> WearSyncStatus.Idle
}

private data class ActionState(
    val status: WearSyncStatus = WearSyncStatus.Idle,
    val inProgress: Boolean = false,
    val pendingMutationTypes: Set<String> = emptySet()
)

private fun DailySnapshotEntity.toWearSummary(lastSyncAtEpochMs: Long?): WearSummary = WearSummary(
    localDate = localDate,
    caloriesRemaining = caloriesRemaining,
    caloriesConsumed = caloriesConsumed,
    calorieTarget = calorieTarget,
    planStatus = planStatus,
    planReasonCode = planReasonCode,
    minimumCalorieTarget = minimumCalorieTarget,
    foodDayComplete = foodDayComplete,
    foodDayStatus = foodDayStatus,
    foodDaySource = foodDaySource,
    foodDayRepresentative = foodDayRepresentative,
    foodDayRevision = foodDayRevision,
    todayWeightGrams = todayWeightGrams,
    todayWeightRevision = todayWeightRevision,
    latestWeightGrams = latestWeightGrams,
    latestWeightDate = latestWeightDate,
    weightUnit = weightUnit,
    goalStartWeightGrams = goalStartWeightGrams,
    goalTargetWeightGrams = goalTargetWeightGrams,
    goalCurrentWeightGrams = goalCurrentWeightGrams,
    goalDailyDeficit = goalDailyDeficit,
    goalProgressPercent = goalProgressPercent,
    goalRemainingWeightGrams = goalRemainingWeightGrams,
    goalIsComplete = goalIsComplete,
    goalProjectionStatus = goalProjectionStatus,
    goalProjectedEndDate = goalProjectedEndDate,
    undoFoodLogId = undoFoodLogId,
    undoName = undoName,
    undoCalories = undoCalories,
    fetchedAtEpochMs = fetchedAtEpochMs,
    lastSyncAtEpochMs = lastSyncAtEpochMs
)
