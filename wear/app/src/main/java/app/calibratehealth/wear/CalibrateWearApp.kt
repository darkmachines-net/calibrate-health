/** Compose watch UI for pairing, calorie summary, actions, weight entry, and account recovery. */

package app.calibratehealth.wear

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.TransformingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberTransformingLazyColumnState
import androidx.wear.compose.material3.AppScaffold
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.ButtonDefaults
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.PickerGroup
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.Text
import androidx.wear.compose.material3.TimeText
import androidx.wear.compose.material3.rememberPickerState
import androidx.wear.compose.navigation.SwipeDismissableNavHost
import androidx.wear.compose.navigation.composable
import androidx.wear.compose.navigation.rememberSwipeDismissableNavController
import app.calibratehealth.wear.actions.WearHomeUiState
import app.calibratehealth.wear.notifications.WearReminderDeepLink
import app.calibratehealth.wear.notifications.WearReminderNotification
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToInt

private const val SUMMARY_ROUTE = "summary"
private const val CONNECTION_ROUTE = "connection"
private const val WEIGHT_ROUTE = "weight"

/** Composes the watch pairing, summary, action, weight-entry, and recovery surfaces from caller-owned state. */
@Composable
fun CalibrateWearApp(
    appState: WearAppState,
    serverConfig: WearServerConfig,
    homeState: WearHomeUiState = WearHomeUiState(),
    onSaveWeight: (WearSummary, Long) -> Unit = { _, _ -> },
    disconnecting: Boolean = false,
    disconnectError: String? = null,
    publicResourceHandoffStatus: String? = null,
    onOpenPrivacyOnPhone: () -> Unit = {},
    onOpenAccountDeletionOnPhone: () -> Unit = {},
    onDisconnect: () -> Unit = {},
    reminderDeepLink: WearReminderDeepLink? = null,
    reminderDeepLinkRequest: Long = 0,
    modifier: Modifier = Modifier
) {
    // Wear navigation retains destination lambdas; updated state prevents a destination from
    // continuing to render its initial pairing snapshot after the first sync commits.
    val currentAppState = rememberUpdatedState(appState)
    val currentHomeState = rememberUpdatedState(homeState)
    val currentDisconnecting = rememberUpdatedState(disconnecting)
    val currentDisconnectError = rememberUpdatedState(disconnectError)
    val currentPublicResourceHandoffStatus = rememberUpdatedState(publicResourceHandoffStatus)
    val currentOnSaveWeight = rememberUpdatedState(onSaveWeight)
    val currentOnOpenPrivacyOnPhone = rememberUpdatedState(onOpenPrivacyOnPhone)
    val currentOnOpenAccountDeletionOnPhone = rememberUpdatedState(onOpenAccountDeletionOnPhone)
    val currentOnDisconnect = rememberUpdatedState(onDisconnect)
    MaterialTheme {
        val navController = rememberSwipeDismissableNavController()
        val currentBackStackEntry by navController.currentBackStackEntryFlow.collectAsState(
            initial = navController.currentBackStackEntry
        )
        val fullBleedSummary = appState is WearAppState.Ready &&
            currentBackStackEntry?.destination?.route == SUMMARY_ROUTE
        AppScaffold(
            modifier = modifier,
            timeText = { if (!fullBleedSummary) TimeText() }
        ) {
            val reminderNavigationReady = appState is WearAppState.Ready
            LaunchedEffect(reminderDeepLinkRequest, reminderDeepLink, reminderNavigationReady) {
                if (reminderDeepLink == null || !reminderNavigationReady) return@LaunchedEffect
                if (reminderDeepLink.destination == WearReminderNotification.DESTINATION_WEIGHT) {
                    navController.navigate(WEIGHT_ROUTE) { launchSingleTop = true }
                } else {
                    navController.popBackStack(SUMMARY_ROUTE, inclusive = false)
                }
            }
            SwipeDismissableNavHost(navController = navController, startDestination = SUMMARY_ROUTE) {
                composable(SUMMARY_ROUTE) {
                    SummaryScreen(
                        appState = currentAppState.value,
                        homeState = currentHomeState.value,
                        onOpenWeight = { navController.navigate(WEIGHT_ROUTE) },
                        onOpenConnection = { navController.navigate(CONNECTION_ROUTE) },
                    )
                }
                composable(CONNECTION_ROUTE) {
                    ConnectionScreen(
                        appState = currentAppState.value,
                        serverConfig = serverConfig,
                        disconnecting = currentDisconnecting.value,
                        disconnectError = currentDisconnectError.value,
                        publicResourceHandoffStatus = currentPublicResourceHandoffStatus.value,
                        onOpenPrivacyOnPhone = currentOnOpenPrivacyOnPhone.value,
                        onOpenAccountDeletionOnPhone = currentOnOpenAccountDeletionOnPhone.value,
                        onDisconnect = currentOnDisconnect.value
                    )
                }
                composable(WEIGHT_ROUTE) {
                    val latestHomeState = currentHomeState.value
                    val summary = latestHomeState.summary
                    if (summary != null) {
                        WeightScreen(
                            summary = summary,
                            saving = latestHomeState.actionInProgress ||
                                "metric.upsert" in latestHomeState.pendingMutationTypes,
                            onSave = { grams ->
                                currentOnSaveWeight.value(summary, grams)
                                navController.popBackStack()
                            }
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun SummaryScreen(
    appState: WearAppState,
    homeState: WearHomeUiState,
    onOpenWeight: () -> Unit,
    onOpenConnection: () -> Unit
) {
    if (appState is WearAppState.Ready) {
        ReadySummaryDashboard(
            summary = appState.summary,
            homeState = homeState,
            onOpenWeight = onOpenWeight,
            onOpenConnection = onOpenConnection
        )
        return
    }

    val listState = rememberTransformingLazyColumnState()
    ScreenScaffold(scrollState = listState, edgeButton = {}) { contentPadding ->
        TransformingLazyColumn(
            state = listState,
            contentPadding = contentPadding,
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.fillMaxSize()
        ) {
            item { CalibrateBrand() }
            when (appState) {
                WearAppState.Unpaired -> item { StatusText("Pair with Calibrate on your phone to see today's summary.") }
                WearAppState.Pairing -> item { StatusText("Pairing securely with your phone...") }
                is WearAppState.PairingError -> item { StatusText(appState.message) }
                is WearAppState.UpgradeRequired -> item { StatusText(appState.message) }
                is WearAppState.Paired -> item {
                    val status = (homeState.syncStatus as? WearSyncStatus.Error)?.message
                        ?: "Paired securely. Waiting for the first health sync."
                    StatusText(status)
                }
                is WearAppState.Ready -> Unit
            }
            item {
                Button(
                    onClick = onOpenConnection,
                    label = { Text("Connection") },
                    secondaryLabel = { Text(connectionLabel(appState, homeState.syncStatus)) },
                    modifier = Modifier
                        .fillMaxWidth()
                        .clearAndSetSemantics {
                            contentDescription = "Connection. ${connectionLabel(appState, homeState.syncStatus)}"
                            onClick(label = "Connection") {
                                onOpenConnection()
                                true
                            }
                        }
                )
            }
        }
    }
}

@Composable
private fun ReadySummaryDashboard(
    summary: WearSummary,
    homeState: WearHomeUiState,
    onOpenWeight: () -> Unit,
    onOpenConnection: () -> Unit
) {
    val displaySummary = summary.suppressPlanForPendingWeight(homeState.pendingMutationTypes)
    val listState = rememberTransformingLazyColumnState()
    val ringVisible = !listState.canScrollBackward
    val ringVisibility by animateFloatAsState(
        targetValue = if (ringVisible) 1f else 0f,
        animationSpec = tween(
            durationMillis = if (ringVisible) {
                SUMMARY_RING_ENTER_DURATION_MS
            } else {
                SUMMARY_RING_EXIT_DURATION_MS
            }
        ),
        label = "calorie ring visibility"
    )
    val progress = if (displaySummary.isFoodTrackingPaused || !displaySummary.isCaloriePlanAvailable) {
        null
    } else {
        calorieProgressFraction(displaySummary.caloriesConsumed, displaySummary.calorieTarget)
    }
    val progressColor = if ((displaySummary.caloriesRemaining ?: 0) < 0) CALIBRATE_DANGER else CALIBRATE_GREEN

    BoxWithConstraints(
        modifier = Modifier
            .fillMaxSize()
            .background(CALIBRATE_BACKGROUND)
    ) {
        val dashboardDiameter = summaryDashboardDiameter(maxWidth.value, maxHeight.value).dp
        val dashboardHeight = maxHeight
        val compactDashboard = dashboardDiameter.value < SUMMARY_COMPACT_DIAMETER_DP
        val ringScale = calorieRingScale(ringVisibility)
        CalorieProgressRing(
            progress = progress,
            progressColor = progressColor,
            modifier = Modifier
                .align(Alignment.Center)
                .size(dashboardDiameter)
                .graphicsLayer {
                    alpha = ringVisibility
                    scaleX = ringScale
                    scaleY = ringScale
                }
        )
        ScreenScaffold(scrollState = listState, edgeButton = {}) { contentPadding ->
            TransformingLazyColumn(
                state = listState,
                contentPadding = contentPadding,
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier.fillMaxSize()
            ) {
                item(key = "calorie-hero") {
                    CalorieHero(
                        summary = displaySummary,
                        compactDashboard = compactDashboard,
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(dashboardHeight)
                    )
                }
                item(key = "weight") {
                    val weightSaving = homeState.actionInProgress ||
                        "metric.upsert" in homeState.pendingMutationTypes
                    Button(
                        onClick = onOpenWeight,
                        enabled = !weightSaving,
                        label = { Text(if (weightSaving) "Saving weight..." else "Log weight") },
                        secondaryLabel = {
                            Text(
                                summary.editableWeightGrams?.let {
                                    "Current ${SummaryFormatter.weight(it, summary.weightUnit)}"
                                } ?: "Enter today's weight"
                            )
                        },
                        colors = ButtonDefaults.buttonColors(
                            containerColor = CALIBRATE_GREEN,
                            contentColor = CALIBRATE_BACKGROUND,
                            secondaryContentColor = CALIBRATE_BACKGROUND
                        ),
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = SUMMARY_ITEM_HORIZONTAL_PADDING)
                    )
                }
                item(key = "goal") { GoalProgressSection(displaySummary) }
                summaryStatus(homeState)?.let { status ->
                    item(key = "status") {
                        Text(
                            status.label,
                            style = MaterialTheme.typography.labelSmall,
                            color = status.color,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth()
                        )
                    }
                }
                item(key = "connection") {
                    Button(
                        onClick = onOpenConnection,
                        label = { Text("Connection") },
                        secondaryLabel = { Text(connectionLabel(WearAppState.Ready(summary), homeState.syncStatus)) },
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = SUMMARY_ITEM_HORIZONTAL_PADDING)
                            .clearAndSetSemantics {
                                contentDescription = "Connection. ${connectionLabel(WearAppState.Ready(summary), homeState.syncStatus)}"
                                onClick(label = "Connection") {
                                    onOpenConnection()
                                    true
                                }
                            }
                    )
                }
                item(key = "bottom-space") {
                    Spacer(modifier = Modifier.height(SUMMARY_BOTTOM_SPACER_HEIGHT))
                }
            }
        }
    }
}

@Composable
private fun CalorieHero(
    summary: WearSummary,
    compactDashboard: Boolean,
    modifier: Modifier = Modifier
) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = modifier.semantics(mergeDescendants = true) {
            contentDescription = calorieAccessibilityDescription(summary)
            if (!summary.isFoodTrackingPaused && summary.isCaloriePlanAvailable) {
                calorieProgressFraction(summary.caloriesConsumed, summary.calorieTarget)?.let {
                    progressBarRangeInfo = ProgressBarRangeInfo(it, 0f..1f)
                }
            }
        }
    ) {
        if (summary.isFoodTrackingPaused) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(4.dp),
                modifier = Modifier.padding(horizontal = 20.dp)
            ) {
                CalibrateBrand()
                Text(
                    text = "Ⅱ",
                    fontSize = 34.sp,
                    fontWeight = FontWeight.Bold,
                    color = CALIBRATE_GREEN
                )
                Text(
                    text = "Tracking paused",
                    textAlign = TextAlign.Center,
                    fontWeight = FontWeight.Bold,
                    color = CALIBRATE_FOREGROUND,
                    style = MaterialTheme.typography.titleLarge
                )
                Text(
                    text = "Daily calories are paused",
                    textAlign = TextAlign.Center,
                    color = CALIBRATE_SECONDARY_TEXT,
                    style = MaterialTheme.typography.labelSmall
                )
            }
            return@Box
        }

        val caloriesRemaining = summary.caloriesRemaining.takeIf { summary.isCaloriePlanAvailable }
        val balanceValue = caloriesRemaining?.let { SummaryFormatter.calorieCount(abs(it)) } ?: "--"
        val balanceLabel = when {
            caloriesRemaining == null -> "target unavailable"
            caloriesRemaining < 0 -> "kcal over"
            else -> "kcal remaining"
        }
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(1.dp),
            modifier = Modifier
                .offset(y = SUMMARY_HERO_VERTICAL_OFFSET)
                .padding(horizontal = 18.dp)
        ) {
            Text(
                balanceValue,
                style = if (compactDashboard) {
                    MaterialTheme.typography.titleLarge
                } else {
                    MaterialTheme.typography.displaySmall
                }
            )
            Text(balanceLabel, style = MaterialTheme.typography.labelMedium)
            Text(SummaryFormatter.calorieProgress(summary), style = MaterialTheme.typography.labelSmall)
        }
    }
}

@Composable
private fun CalorieProgressRing(
    progress: Float?,
    progressColor: Color,
    modifier: Modifier = Modifier
) {
    Canvas(modifier = modifier) {
        val strokeWidth = 10.dp.toPx()
        val strokeInset = strokeWidth / 2f
        val arcSize = Size(
            width = (size.width - strokeWidth).coerceAtLeast(0f),
            height = (size.height - strokeWidth).coerceAtLeast(0f)
        )
        val arcOrigin = Offset(strokeInset, strokeInset)
        drawArc(
            color = CALIBRATE_RING_TRACK,
            startAngle = CALORIE_RING_START_ANGLE,
            sweepAngle = CALORIE_RING_SWEEP_ANGLE,
            useCenter = false,
            topLeft = arcOrigin,
            size = arcSize,
            style = Stroke(width = strokeWidth, cap = StrokeCap.Round)
        )
        progress?.let {
            drawArc(
                color = progressColor,
                startAngle = CALORIE_RING_START_ANGLE,
                sweepAngle = CALORIE_RING_SWEEP_ANGLE * it,
                useCenter = false,
                topLeft = arcOrigin,
                size = arcSize,
                style = Stroke(width = strokeWidth, cap = StrokeCap.Round)
            )
        }
    }
}

@Composable
private fun GoalProgressSection(summary: WearSummary) {
    val progress = goalProgressFraction(summary)
    Column(
        verticalArrangement = Arrangement.spacedBy(6.dp),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = SUMMARY_SECTION_HORIZONTAL_PADDING, vertical = 12.dp)
            .semantics(mergeDescendants = true) {
                contentDescription = goalAccessibilityDescription(summary)
                progress?.let { progressBarRangeInfo = ProgressBarRangeInfo(it, 0f..1f) }
            }
    ) {
        Text("Goal", style = MaterialTheme.typography.labelSmall, color = CALIBRATE_SECONDARY_TEXT)
        Text(goalProgressHeadline(summary), style = MaterialTheme.typography.titleMedium)
        GoalProgressBar(progress = progress)
        Text(
            goalProgressDetail(summary),
            style = MaterialTheme.typography.bodySmall,
            color = CALIBRATE_SECONDARY_TEXT
        )
        Text(
            goalProjectionLabel(summary),
            style = MaterialTheme.typography.labelSmall,
            color = CALIBRATE_GOAL
        )
    }
}

@Composable
private fun GoalProgressBar(progress: Float?) {
    Canvas(
        modifier = Modifier
            .fillMaxWidth()
            .height(8.dp)
    ) {
        val radius = size.height / 2f
        drawRoundRect(
            color = CALIBRATE_RING_TRACK,
            cornerRadius = CornerRadius(radius, radius)
        )
        val progressWidth = size.width * (progress ?: 0f)
        if (progressWidth > 0f) {
            drawRoundRect(
                color = CALIBRATE_GOAL,
                size = Size(progressWidth, size.height),
                cornerRadius = CornerRadius(radius, radius)
            )
        }
    }
}

private data class SummaryDashboardStatus(val label: String, val color: Color)

private fun summaryStatus(homeState: WearHomeUiState): SummaryDashboardStatus? = when {
    homeState.actionInProgress -> SummaryDashboardStatus("Syncing...", CALIBRATE_SECONDARY_TEXT)
    homeState.syncStatus is WearSyncStatus.Error -> SummaryDashboardStatus("Sync needs attention", CALIBRATE_DANGER)
    else -> null
}

@Composable
private fun CalibrateBrand(showWordmark: Boolean = true) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Canvas(modifier = Modifier.size(19.dp)) {
            val gaugeStroke = 3.5.dp.toPx()
            drawArc(
                color = CALIBRATE_FOREGROUND,
                startAngle = 45f,
                sweepAngle = 270f,
                useCenter = false,
                style = Stroke(width = gaugeStroke, cap = StrokeCap.Butt)
            )
            drawLine(
                color = CALIBRATE_FOREGROUND,
                start = Offset(size.width * 0.5f, size.height * 0.03f),
                end = Offset(size.width * 0.5f, size.height * 0.23f),
                strokeWidth = 2.5.dp.toPx(),
                cap = StrokeCap.Round
            )
            val hub = Offset(size.width * 0.45f, size.height * 0.61f)
            drawLine(
                color = CALIBRATE_NEEDLE,
                start = hub,
                end = Offset(size.width * 0.79f, size.height * 0.27f),
                strokeWidth = 3.dp.toPx(),
                cap = StrokeCap.Round
            )
            drawCircle(color = CALIBRATE_HUB, radius = 3.3.dp.toPx(), center = hub)
            drawCircle(color = CALIBRATE_FOREGROUND, radius = 1.4.dp.toPx(), center = hub)
        }
        if (showWordmark) {
            Text(
                "calibrate",
                style = MaterialTheme.typography.labelSmall.copy(
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold
                ),
                color = CALIBRATE_FOREGROUND,
                maxLines = 1,
                softWrap = false
            )
        }
    }
}

private val CALIBRATE_BACKGROUND = Color(0xFF0E1510)
private val CALIBRATE_FOREGROUND = Color(0xFFF3F7F1)
private val CALIBRATE_SECONDARY_TEXT = Color(0xFFB6C5B6)
private val CALIBRATE_RING_TRACK = Color(0xFF29382B)
private val CALIBRATE_GREEN = Color(0xFF71D478)
private val CALIBRATE_GOAL = Color(0xFF8DDD2B)
private val CALIBRATE_NEEDLE = Color(0xFF8DDD2B)
private val CALIBRATE_HUB = Color(0xFF2E7D32)
private val CALIBRATE_DANGER = Color(0xFFFF796E)
private const val CALORIE_RING_START_ANGLE = 140f
private const val CALORIE_RING_SWEEP_ANGLE = 260f
private const val SUMMARY_COMPACT_DIAMETER_DP = 160f
// The ring returns quickly, then lingers while expanding outward so the exit motion reads clearly.
private const val SUMMARY_RING_ENTER_DURATION_MS = 180
private const val SUMMARY_RING_EXIT_DURATION_MS = 320
private const val SUMMARY_RING_MAX_SCALE = 1.12f
// Centers the calorie copy independently of the list's first-item placement on a round screen.
private val SUMMARY_HERO_VERTICAL_OFFSET = (-18).dp
// Keeps full-width dashboard content inside the usable horizontal chord of a round display.
private val SUMMARY_ITEM_HORIZONTAL_PADDING = 12.dp
private val SUMMARY_SECTION_HORIZONTAL_PADDING = 26.dp
// Lets the final action scroll above the curved bottom edge instead of stopping inside it.
private val SUMMARY_BOTTOM_SPACER_HEIGHT = 48.dp
private val WEIGHT_PICKER_HEIGHT = 76.dp
// Keeps the numeric picker columns visually joined while leaving room for three whole digits.
private val WEIGHT_PICKER_WHOLE_WIDTH = 58.dp
private val WEIGHT_PICKER_DECIMAL_WIDTH = 48.dp
private val WEIGHT_PICKER_GROUP_WIDTH = WEIGHT_PICKER_WHOLE_WIDTH + WEIGHT_PICKER_DECIMAL_WIDTH
// Pulls the static unit beside the edge-aligned picker text without shrinking either touch target.
private val WEIGHT_PICKER_UNIT_JOIN_OFFSET = (-26).dp
private val GOAL_DATE_FORMATTER = DateTimeFormatter.ofPattern("MMM d, uuuu", Locale.US)

internal fun summaryDashboardDiameter(widthDp: Float, heightDp: Float): Float =
    minOf(widthDp, heightDp).coerceAtLeast(0f)

internal fun calorieRingScale(visibility: Float): Float {
    val boundedVisibility = visibility.coerceIn(0f, 1f)
    return 1f + ((1f - boundedVisibility) * (SUMMARY_RING_MAX_SCALE - 1f))
}

internal fun calorieProgressFraction(consumed: Int?, target: Int?): Float? = when {
    consumed == null || target == null || target <= 0 -> null
    else -> (consumed.toFloat() / target).coerceIn(0f, 1f)
}

internal fun goalProgressFraction(summary: WearSummary): Float? = when {
    summary.goalTargetWeightGrams == null -> null
    summary.goalDailyDeficit == 0 -> null
    summary.goalIsComplete == true -> 1f
    summary.goalProgressPercent == null -> null
    else -> (summary.goalProgressPercent.toFloat() / 100f).coerceIn(0f, 1f)
}

internal fun calorieAccessibilityDescription(summary: WearSummary): String {
    if (summary.isFoodTrackingPaused) return "Calorie tracking paused. Review pause on phone."
    if (summary.planStatus == WEIGHT_SYNCING_PLAN_STATUS) return "Weight change syncing. Calorie target will return after the server rechecks the plan."
    if (!summary.isCaloriePlanAvailable) return "Calorie target unavailable. Review calorie plan on phone."
    val consumed = summary.caloriesConsumed
    val target = summary.calorieTarget
    val remaining = summary.caloriesRemaining
    if (consumed == null || target == null || remaining == null) return "Calorie target unavailable."
    val balance = if (remaining >= 0) {
        "${SummaryFormatter.calorieCount(remaining)} calories remaining."
    } else {
        "${SummaryFormatter.calorieCount(abs(remaining))} calories over target."
    }
    return "${SummaryFormatter.calorieCount(consumed)} calories consumed of " +
        "${SummaryFormatter.calorieCount(target)}. $balance"
}

internal fun goalProgressHeadline(summary: WearSummary): String = when {
    summary.planStatus == WEIGHT_SYNCING_PLAN_STATUS -> "Rechecking calorie plan"
    !summary.isCaloriePlanAvailable -> "Review calorie plan"
    summary.goalDailyDeficit == 0 -> "Maintenance goal"
    summary.goalIsComplete == true -> "Goal reached"
    summary.goalProgressPercent != null -> "${summary.goalProgressPercent.roundToInt()}% to goal"
    else -> "Goal progress"
}

internal fun goalProgressDetail(summary: WearSummary): String {
    val target = summary.goalTargetWeightGrams?.let { SummaryFormatter.weight(it, summary.weightUnit) }
        ?: return "Goal unavailable"
    val current = summary.goalCurrentWeightGrams?.let { SummaryFormatter.weight(it, summary.weightUnit) }
    return if (current == null) "Goal $target | Log weight" else "Current $current | Goal $target"
}

internal fun goalProjectionLabel(summary: WearSummary): String {
    if (!summary.isCaloriePlanAvailable) return "Projection unavailable"
    return when (summary.goalProjectionStatus) {
        "maintenance" -> "No projected date"
        "reached" -> "Goal reached"
        "projected" -> {
            val projectedDate = summary.goalProjectedEndDate
                ?.let { runCatching { LocalDate.parse(it) }.getOrNull() }
                ?: return "Projection unavailable"
            "Projected ${projectedDate.format(GOAL_DATE_FORMATTER)}"
        }
        else -> "Projection unavailable"
    }
}

internal fun goalAccessibilityDescription(summary: WearSummary): String {
    val headline = goalProgressHeadline(summary)
    val detail = goalProgressDetail(summary).replace(" | ", ". ")
    val remaining = summary.goalRemainingWeightGrams?.takeIf { it > 0 }?.let {
        val suffix = if (summary.goalDailyDeficit == 0) "from target" else "remaining"
        " ${SummaryFormatter.weight(it, summary.weightUnit)} $suffix."
    }.orEmpty()
    return "$headline. $detail.$remaining ${goalProjectionLabel(summary)}."
}

@Composable
private fun WeightScreen(summary: WearSummary, saving: Boolean, onSave: (Long) -> Unit) {
    val startingWeight = summary.editableWeightGrams ?: WeightPickerValues.DEFAULT_WEIGHT_GRAMS
    val pickerValues = remember(summary.localDate, startingWeight, summary.weightUnit) {
        WeightPickerValues.from(startingWeight, summary.weightUnit)
    }
    val wholePickerState = rememberPickerState(
        initialNumberOfOptions = pickerValues.wholeOptionCount,
        initiallySelectedIndex = pickerValues.selectedWholeIndex
    )
    val decimalPickerState = rememberPickerState(
        initialNumberOfOptions = WeightPickerValues.DECIMAL_OPTION_COUNT,
        initiallySelectedIndex = pickerValues.selectedDecimal
    )
    var selectedPickerIndex by remember { mutableIntStateOf(0) }
    val selectedPickerState = if (selectedPickerIndex == 0) wholePickerState else decimalPickerState
    val scaffoldState = rememberTransformingLazyColumnState()
    val boundedDecimal = pickerValues.decimalAt(
        wholeOptionIndex = wholePickerState.selectedOptionIndex,
        decimal = decimalPickerState.selectedOptionIndex
    )
    LaunchedEffect(wholePickerState.selectedOptionIndex, decimalPickerState.selectedOptionIndex, boundedDecimal) {
        if (decimalPickerState.selectedOptionIndex != boundedDecimal) {
            decimalPickerState.scrollToOption(boundedDecimal)
        }
    }
    val selectedGrams = pickerValues.gramsFor(
        wholeOptionIndex = wholePickerState.selectedOptionIndex,
        decimal = boundedDecimal
    )

    ScreenScaffold(scrollState = scaffoldState, edgeButton = {}) { contentPadding ->
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(4.dp),
            modifier = Modifier
                .fillMaxSize()
                .background(MaterialTheme.colorScheme.background)
                .padding(contentPadding)
                .padding(horizontal = 20.dp, vertical = 8.dp)
        ) {
            Text("Log weight", style = MaterialTheme.typography.titleMedium)
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(WEIGHT_PICKER_HEIGHT),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically
            ) {
                PickerGroup(
                    selectedPickerState = selectedPickerState,
                    autoCenter = false,
                    modifier = Modifier
                        .width(WEIGHT_PICKER_GROUP_WIDTH)
                        .height(WEIGHT_PICKER_HEIGHT)
                ) {
                    PickerGroupItem(
                        pickerState = wholePickerState,
                        selected = selectedPickerIndex == 0,
                        onSelected = { selectedPickerIndex = 0 },
                        contentDescription = {
                            "Whole number ${pickerValues.wholeAt(wholePickerState.selectedOptionIndex)}"
                        },
                        modifier = Modifier.size(WEIGHT_PICKER_WHOLE_WIDTH, WEIGHT_PICKER_HEIGHT),
                        option = { optionIndex, _ ->
                            Text(
                                text = pickerValues.wholeAt(optionIndex).toString(),
                                style = MaterialTheme.typography.titleLarge,
                                fontWeight = FontWeight.Bold,
                                textAlign = TextAlign.End,
                                modifier = Modifier.width(WEIGHT_PICKER_WHOLE_WIDTH)
                            )
                        }
                    )
                    PickerGroupItem(
                        pickerState = decimalPickerState,
                        selected = selectedPickerIndex == 1,
                        onSelected = { selectedPickerIndex = 1 },
                        contentDescription = { "Decimal $boundedDecimal" },
                        modifier = Modifier.size(WEIGHT_PICKER_DECIMAL_WIDTH, WEIGHT_PICKER_HEIGHT),
                        option = { optionIndex, _ ->
                            Text(
                                text = ".$optionIndex",
                                style = MaterialTheme.typography.titleLarge,
                                fontWeight = FontWeight.Bold,
                                textAlign = TextAlign.Start,
                                modifier = Modifier.width(WEIGHT_PICKER_DECIMAL_WIDTH)
                            )
                        }
                    )
                }
                Text(
                    text = pickerValues.unitLabel,
                    style = MaterialTheme.typography.titleMedium,
                    color = CALIBRATE_SECONDARY_TEXT,
                    modifier = Modifier.offset(x = WEIGHT_PICKER_UNIT_JOIN_OFFSET)
                )
            }
            Button(
                onClick = { onSave(selectedGrams) },
                enabled = !saving,
                label = {
                    Text(if (saving) "Saving..." else "Save")
                },
                colors = ButtonDefaults.buttonColors(
                    containerColor = CALIBRATE_GREEN,
                    contentColor = CALIBRATE_BACKGROUND,
                    secondaryContentColor = CALIBRATE_BACKGROUND
                ),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp)
            )
            Spacer(modifier = Modifier.height(8.dp))
        }
    }
}

private fun connectionLabel(appState: WearAppState, syncStatus: WearSyncStatus): String = when (appState) {
    WearAppState.Unpaired -> "Phone setup required"
    WearAppState.Pairing -> "Pairing in progress"
    is WearAppState.PairingError -> "Pairing needs attention"
    is WearAppState.UpgradeRequired -> "Update required"
    is WearAppState.Paired -> when {
        appState.confirmationPending -> "Phone confirmation pending"
        syncStatus is WearSyncStatus.Error -> "Sync needs attention"
        else -> "First sync pending"
    }
    is WearAppState.Ready -> SummaryFormatter.sync(syncStatus, appState.summary.lastSyncAtEpochMs)
}

@Composable
private fun SectionTitle(text: String) {
    Text(text, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
}

@Composable
private fun StatusText(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        textAlign = TextAlign.Center,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 24.dp)
    )
}

@Composable
private fun ConnectionScreen(
    appState: WearAppState,
    serverConfig: WearServerConfig,
    disconnecting: Boolean,
    disconnectError: String?,
    publicResourceHandoffStatus: String?,
    onOpenPrivacyOnPhone: () -> Unit,
    onOpenAccountDeletionOnPhone: () -> Unit,
    onDisconnect: () -> Unit
) {
    var confirmDisconnect by remember(appState) { mutableStateOf(false) }
    val listState = rememberTransformingLazyColumnState()
    ScreenScaffold(scrollState = listState, edgeButton = {}) { contentPadding ->
        TransformingLazyColumn(
            state = listState,
            contentPadding = contentPadding,
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.fillMaxSize()
        ) {
            item { SectionTitle("Connection") }
            item {
                Column(
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp)
                ) {
                    Text("Server", style = MaterialTheme.typography.labelSmall)
                    Text(serverConfig.defaultServerUrl, style = MaterialTheme.typography.bodySmall)
                    Text("${serverConfig.buildVariant} build", style = MaterialTheme.typography.labelSmall)
                }
            }
            item { StatusText(connectionDetail(appState)) }
            disconnectError?.let { error -> item { StatusText(error) } }
            if (
                appState is WearAppState.Paired || appState is WearAppState.Ready ||
                appState is WearAppState.UpgradeRequired
            ) {
                item { SectionTitle("Privacy and account") }
                item {
                    Button(
                        onClick = onOpenPrivacyOnPhone,
                        label = { Text("Privacy policy") },
                        secondaryLabel = { Text("Open public policy on phone") },
                        modifier = Modifier.fillMaxWidth()
                    )
                }
                item {
                    Button(
                        onClick = onOpenAccountDeletionOnPhone,
                        label = { Text("Account deletion") },
                        secondaryLabel = { Text("Open public request page on phone") },
                        modifier = Modifier.fillMaxWidth()
                    )
                }
                publicResourceHandoffStatus?.let { status -> item { StatusText(status) } }
            }
            if (
                appState is WearAppState.Paired || appState is WearAppState.Ready ||
                appState is WearAppState.PairingError || appState is WearAppState.UpgradeRequired || disconnectError != null
            ) {
                if (confirmDisconnect) {
                    item { StatusText("This clears Calibrate data and sign-in only from this watch.") }
                    item {
                        Button(
                            onClick = onDisconnect,
                            enabled = !disconnecting,
                            label = { Text(if (disconnecting) "Disconnecting..." else "Confirm disconnect") },
                            secondaryLabel = { Text("Phone and other devices stay signed in") },
                            modifier = Modifier.fillMaxWidth()
                        )
                    }
                    item {
                        Button(
                            onClick = { confirmDisconnect = false },
                            enabled = !disconnecting,
                            label = { Text("Cancel") },
                            modifier = Modifier.fillMaxWidth()
                        )
                    }
                } else {
                    item {
                        Button(
                            onClick = { confirmDisconnect = true },
                            label = { Text(if (disconnectError == null) "Disconnect this watch" else "Retry local cleanup") },
                            secondaryLabel = { Text("Clear watch-local data only") },
                            modifier = Modifier.fillMaxWidth()
                        )
                    }
                }
            }
        }
    }
}

private fun connectionDetail(appState: WearAppState): String = when (appState) {
    WearAppState.Unpaired -> "Open Calibrate settings on your phone and choose the nearby watch to begin."
    WearAppState.Pairing -> "Keep the phone nearby while this one-time secure pairing completes."
    is WearAppState.PairingError -> appState.message
    is WearAppState.UpgradeRequired -> appState.message
    is WearAppState.Paired -> if (appState.confirmationPending) {
        "This watch is paired securely. Keep your phone nearby to confirm the connection."
    } else {
        "This watch is paired securely. No password is stored on the watch."
    }
    is WearAppState.Ready -> "Paired securely. Health data sync is available."
}

@Preview(name = "Round summary", device = "id:wearos_large_round", showSystemUi = true)
@Composable
private fun SummaryPreview() {
    val summary = WearSummary(
        localDate = "2026-07-16",
        caloriesRemaining = 595,
        caloriesConsumed = 1_240,
        calorieTarget = 1_835,
        planStatus = "available",
        minimumCalorieTarget = 1_500,
        foodDayComplete = false,
        foodDayRevision = null,
        todayWeightGrams = 76_340,
        todayWeightRevision = null,
        latestWeightGrams = 76_340,
        latestWeightDate = "2026-07-16",
        weightUnit = "LB",
        goalStartWeightGrams = 82_000,
        goalTargetWeightGrams = 72_500,
        goalCurrentWeightGrams = 76_340,
        goalDailyDeficit = 500,
        goalProgressPercent = 59.6,
        goalRemainingWeightGrams = 3_840,
        goalIsComplete = false,
        goalProjectionStatus = "projected",
        goalProjectedEndDate = "2026-10-10",
        undoFoodLogId = null,
        undoName = null,
        undoCalories = null,
        fetchedAtEpochMs = 1_000,
        lastSyncAtEpochMs = 1_000
    )
    CalibrateWearApp(
        appState = WearAppState.Ready(summary),
        serverConfig = WearServerConfig("https://calibratehealth.app", "preview"),
        homeState = WearHomeUiState(summary = summary)
    )
}

@Preview(name = "Square unpaired", device = "spec:width=192dp,height=192dp,dpi=320", showSystemUi = true)
@Composable
private fun UnpairedPreview() {
    CalibrateWearApp(
        appState = WearAppState.Unpaired,
        serverConfig = WearServerConfig("https://calibratehealth.app", "preview")
    )
}
