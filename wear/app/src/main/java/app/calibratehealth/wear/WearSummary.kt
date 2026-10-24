/** Watch summary/state models, calorie and sync presentation, and unit-safe weight picker bounds. */

package app.calibratehealth.wear

import java.util.Locale
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/** Cached, account-scoped health state rendered by the watch without waiting for the network. */
data class WearSummary(
    val localDate: String,
    val caloriesRemaining: Int?,
    val caloriesConsumed: Int?,
    val calorieTarget: Int?,
    val planStatus: String = "unknown",
    val planReasonCode: String? = null,
    val minimumCalorieTarget: Int? = null,
    val foodDayComplete: Boolean,
    val foodDayRevision: String?,
    val todayWeightGrams: Long?,
    val todayWeightRevision: String?,
    val latestWeightGrams: Long?,
    val latestWeightDate: String?,
    val weightUnit: String,
    val goalStartWeightGrams: Long? = null,
    val goalTargetWeightGrams: Long? = null,
    val goalCurrentWeightGrams: Long? = null,
    val goalDailyDeficit: Int? = null,
    val goalProgressPercent: Double? = null,
    val goalRemainingWeightGrams: Long? = null,
    val goalIsComplete: Boolean? = null,
    val goalProjectionStatus: String? = null,
    val goalProjectedEndDate: String? = null,
    val undoFoodLogId: Long?,
    val undoName: String?,
    val undoCalories: Int?,
    val fetchedAtEpochMs: Long,
    val lastSyncAtEpochMs: Long?,
    val foodDayStatus: String = if (foodDayComplete) "COMPLETE" else "OPEN",
    val foodDaySource: String? = null,
    val foodDayRepresentative: Boolean = foodDayComplete
) {
    val editableWeightGrams: Long? get() = todayWeightGrams ?: latestWeightGrams
    val hasUndoCandidate: Boolean
        get() = undoFoodLogId != null && !undoName.isNullOrBlank() && undoCalories != null
    val isFoodTrackingPaused: Boolean get() = foodDayStatus == "PAUSED"
    val isCaloriePlanAvailable: Boolean get() = planStatus == "available"
}

internal const val WEIGHT_SYNCING_PLAN_STATUS = "weight_syncing"

internal fun WearSummary.suppressPlanForPendingWeight(pendingMutationTypes: Set<String>): WearSummary =
    if ("metric.upsert" !in pendingMutationTypes) this else copy(
        caloriesRemaining = null,
        calorieTarget = null,
        planStatus = WEIGHT_SYNCING_PLAN_STATUS,
        minimumCalorieTarget = null,
        goalProjectionStatus = "unavailable",
        goalProjectedEndDate = null
    )

sealed interface WearAppState {
    data object Unpaired : WearAppState
    data object Pairing : WearAppState
    data class PairingError(val message: String) : WearAppState
    data class UpgradeRequired(val message: String) : WearAppState
    data class Paired(
        val userId: Long,
        val serverOrigin: String,
        val confirmationPending: Boolean = false
    ) : WearAppState
    data class Ready(val summary: WearSummary) : WearAppState
}

sealed interface WearSyncStatus {
    data object Idle : WearSyncStatus
    data class Pending(val count: Int) : WearSyncStatus
    data class Error(val message: String) : WearSyncStatus
}

object SummaryFormatter {
    /** Formats remaining or excess calories only when the snapshot has an available calorie plan. */
    fun caloriesRemaining(summary: WearSummary): String =
        summary.caloriesRemaining.takeIf { summary.isCaloriePlanAvailable }?.let { value ->
            if (value >= 0) "${calorieCount(value)} kcal left" else "${calorieCount(-value)} kcal over"
        } ?: "Calorie target unavailable"

    /** Formats consumed-versus-target progress or an actionable unavailable-plan explanation. */
    fun calorieProgress(summary: WearSummary): String =
        if (summary.isCaloriePlanAvailable && summary.caloriesConsumed != null && summary.calorieTarget != null) {
            "${calorieCount(summary.caloriesConsumed)} of ${calorieCount(summary.calorieTarget)} kcal"
        } else {
            when (summary.planStatus) {
                WEIGHT_SYNCING_PLAN_STATUS -> "Rechecking calorie plan"
                "requires_review" -> "Review plan on phone"
                else -> "Open phone to finish setup"
            }
        }

    /** Formats a calorie integer or a missing-data placeholder. */
    fun calorieCount(value: Int?): String = value?.let(::formatWholeNumber) ?: "--"

    /** Converts canonical grams into a one-decimal weight label or a missing-data placeholder. */
    fun weight(grams: Long?, unit: String): String {
        if (grams == null) return "--"
        return if (unit.lowercase(Locale.US) == "lb") {
            String.format(Locale.US, "%.1f lb", grams / GRAMS_PER_POUND)
        } else {
            String.format(Locale.US, "%.1f kg", grams / GRAMS_PER_KILOGRAM)
        }
    }

    /** Formats pending, failed, and idle synchronization state with first-sync awareness. */
    fun sync(status: WearSyncStatus, lastSyncAtEpochMs: Long?): String = when (status) {
        WearSyncStatus.Idle -> if (lastSyncAtEpochMs == null) "Waiting for first sync" else "Synced"
        is WearSyncStatus.Pending -> "${status.count} change${if (status.count == 1) "" else "s"} pending"
        is WearSyncStatus.Error -> status.message
    }

    private fun formatWholeNumber(value: Int): String =
        String.format(Locale.US, "%,d", value)

    private const val GRAMS_PER_KILOGRAM = 1_000.0
    private const val GRAMS_PER_POUND = 453.59237
}

/** Maps canonical grams to the whole/decimal columns shown by the native Wear picker. */
class WeightPickerValues private constructor(
    val initialGrams: Long,
    val unitLabel: String,
    private val minimumTenths: Int,
    private val maximumTenths: Int,
    val minimumWhole: Int,
    val maximumWhole: Int,
    val selectedWhole: Int,
    val selectedDecimal: Int
) {
    val wholeOptionCount: Int get() = maximumWhole - minimumWhole + 1
    val selectedWholeIndex: Int get() = selectedWhole - minimumWhole

    /** Maps a picker index to a whole-number value clamped to the supported display range. */
    fun wholeAt(optionIndex: Int): Int =
        (minimumWhole + optionIndex).coerceIn(minimumWhole, maximumWhole)

    /** Clamps the fractional selection at the lower and upper supported weight boundaries. */
    fun decimalAt(wholeOptionIndex: Int, decimal: Int): Int {
        val whole = wholeAt(wholeOptionIndex)
        val minimumDecimal = if (whole == minimumWhole) minimumTenths % DECIMAL_OPTION_COUNT else 0
        val maximumDecimal = if (whole == maximumWhole) maximumTenths % DECIMAL_OPTION_COUNT else DECIMAL_OPTION_COUNT - 1
        return decimal.coerceIn(minimumDecimal, maximumDecimal)
    }

    /** Converts a bounded picker selection to grams, preserving the original grams when the selection is unchanged. */
    fun gramsFor(wholeOptionIndex: Int, decimal: Int): Long {
        val whole = wholeAt(wholeOptionIndex)
        val boundedDecimal = decimalAt(wholeOptionIndex, decimal)
        if (whole == selectedWhole && boundedDecimal == selectedDecimal) return initialGrams

        val displayedTenths = (whole * DECIMAL_OPTION_COUNT) + boundedDecimal
        val grams = if (unitLabel == IMPERIAL_UNIT) {
            (displayedTenths * GRAMS_PER_POUND / DECIMAL_OPTION_COUNT).roundToLong()
        } else {
            displayedTenths * METRIC_TENTH_GRAMS
        }
        return grams.coerceIn(MIN_WEIGHT_GRAMS, MAX_WEIGHT_GRAMS)
    }

    companion object {
        // Gives a first-time weigh-in a neutral picker starting point on the watch.
        const val DEFAULT_WEIGHT_GRAMS = 70_000L
        const val MIN_WEIGHT_GRAMS = 25_000L
        const val MAX_WEIGHT_GRAMS = 400_000L
        const val DECIMAL_OPTION_COUNT = 10
        private const val IMPERIAL_UNIT = "lb"
        private const val METRIC_UNIT = "kg"
        private const val METRIC_TENTH_GRAMS = 100L
        private const val GRAMS_PER_POUND = 453.59237

        /** Builds unit-specific picker bounds and initial selection from clamped canonical grams. */
        fun from(grams: Long, unit: String): WeightPickerValues {
            val boundedGrams = grams.coerceIn(MIN_WEIGHT_GRAMS, MAX_WEIGHT_GRAMS)
            val unitLabel = if (unit.lowercase(Locale.US) == IMPERIAL_UNIT) IMPERIAL_UNIT else METRIC_UNIT
            val selectedTenths = displayTenths(boundedGrams, unitLabel)
            val minimumTenths = minimumDisplayTenths(unitLabel)
            val maximumTenths = maximumDisplayTenths(unitLabel)
            return WeightPickerValues(
                initialGrams = boundedGrams,
                unitLabel = unitLabel,
                minimumTenths = minimumTenths,
                maximumTenths = maximumTenths,
                minimumWhole = minimumTenths / DECIMAL_OPTION_COUNT,
                maximumWhole = maximumTenths / DECIMAL_OPTION_COUNT,
                selectedWhole = selectedTenths / DECIMAL_OPTION_COUNT,
                selectedDecimal = selectedTenths % DECIMAL_OPTION_COUNT
            )
        }

        private fun displayTenths(grams: Long, unit: String): Int =
            if (unit == IMPERIAL_UNIT) {
                (grams * DECIMAL_OPTION_COUNT / GRAMS_PER_POUND).roundToInt()
            } else {
                (grams / METRIC_TENTH_GRAMS.toDouble()).roundToInt()
            }

        private fun minimumDisplayTenths(unit: String): Int = if (unit == IMPERIAL_UNIT) {
            kotlin.math.ceil(MIN_WEIGHT_GRAMS * DECIMAL_OPTION_COUNT / GRAMS_PER_POUND).toInt()
        } else {
            (MIN_WEIGHT_GRAMS / METRIC_TENTH_GRAMS).toInt()
        }

        private fun maximumDisplayTenths(unit: String): Int = if (unit == IMPERIAL_UNIT) {
            kotlin.math.floor(MAX_WEIGHT_GRAMS * DECIMAL_OPTION_COUNT / GRAMS_PER_POUND).toInt()
        } else {
            (MAX_WEIGHT_GRAMS / METRIC_TENTH_GRAMS).toInt()
        }
    }
}
