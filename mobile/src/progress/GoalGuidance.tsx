/** @file Goal completion and maintenance notices, with a lightweight handoff into goal setup. */
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { GoalStatus } from '@calibrate/api-client';
import { router } from 'expo-router';
import { AppButton } from '../components/AppButton';
import { AppNotice } from '../components/AppNotice';
import { AppSection } from '../components/AppSection';
import { AppText } from '../components/AppText';
import { BottomSheetModal } from '../components/BottomSheetModal';
import { spacing } from '../theme';
import { gramsToDisplayWeight } from '../utils/bodyMeasurements';
import { formatWeight, formatWeightUnit } from '../utils/format';
import { formatDateOnlyForDisplay } from '../utils/dates';
import type { GoalEditorIntent } from './MaintenanceGoalEditor';

const STATUS_LABELS = {
    within_range: 'Within range', above_range: 'Above range', below_range: 'Below range',
    insufficient: 'Building your weight trend', stale: 'A recent weigh-in is needed',
    unavailable: 'Weight trend unavailable', range_required: 'Choose your maintenance range'
} as const;

/** Present current range and equally available responses to an excursion. */
export function GoalGuidance({ status, onEdit, onWeighIn, pending, canReview = true, compact = false }: {
    status: GoalStatus;
    onEdit: (intent: GoalEditorIntent) => void;
    onWeighIn: () => void;
    pending: boolean;
    canReview?: boolean;
    compact?: boolean;
}) {
    const [dismissed, setDismissed] = useState<string | null>(null);
    const maintenance = status.maintenance;
    const range = maintenance?.range;
    const hasRange = maintenance && maintenance.status !== 'range_required';
    const excursion = maintenance && (maintenance.status === 'above_range' || maintenance.status === 'below_range');
    const episode = excursion ? JSON.stringify([status.goal?.id, maintenance.status, range]) : null;
    useEffect(() => {
        if (episode === null) setDismissed(null);
    }, [episode]);
    const weight = (grams: number) => gramsToDisplayWeight(grams, status.weight_unit);
    const unit = formatWeightUnit(status.weight_unit);
    if (!maintenance || !range) return null;
    return <AppSection density="compact" testID="maintenance-guidance">
        <View style={{ gap: spacing.sm }}>
            <AppText variant="screenTitle">Maintenance</AppText>
            <AppText accessibilityLiveRegion="polite">{pending ? 'Updating your weight trend' : STATUS_LABELS[maintenance.status]}</AppText>
            {hasRange && <AppText variant="muted">
                Target {weight(range.target_weight_grams)} {unit} | Range {weight(range.lower_weight_grams)} to {weight(range.upper_weight_grams)} {unit}
            </AppText>}
            {!pending && status.evidence === 'current' && status.trend && <AppText variant="muted">
                Underlying weight {weight(status.trend.weight_grams)} {unit} | Likely range {weight(status.trend.lower_grams)} to {weight(status.trend.upper_grams)} {unit}
            </AppText>}
            {!status.tracking && <AppText variant="muted">Tracking weight only</AppText>}
            {status.tracking && status.target_kcal != null && <AppText>Daily budget {status.target_kcal.toLocaleString()} kcal</AppText>}
            {!compact && <AppButton title="Weigh in" variant="secondary" onPress={onWeighIn} />}
            {compact && !hasRange && <AppButton title="Set maintenance range" variant="secondary"
                disabled={pending} onPress={() => onEdit('edit')} />}
            {!pending && canReview && excursion && dismissed !== episode && <>
                <AppButton title="Review a return-to-target plan" variant="secondary" onPress={() => onEdit('return')} />
                <AppButton title="Adjust maintenance target" variant="secondary" onPress={() => onEdit('reset')} />
                <AppButton title="Continue monitoring" variant="secondary" onPress={() => setDismissed(episode)} />
            </>}
            {!compact && <AppButton title={hasRange ? 'Edit maintenance target and range' : 'Set maintenance range'}
                variant="ghost" disabled={pending} onPress={() => onEdit('edit')} />}
            {!compact && status.tracking && <AppButton title="Turn off calorie tracking" variant="ghost"
                disabled={pending} onPress={() => onEdit('pause')} />}
            {!compact && !status.tracking && <AppButton title="Start calorie tracking" variant="ghost"
                disabled={pending} onPress={() => onEdit('enable')} />}
            {!compact && <AppButton title="Set another weight goal" variant="ghost" disabled={pending} onPress={() => onEdit('new')} />}
        </View>
    </AppSection>;
}

/** Give the completed milestone and its next action a contained place above the Progress trend. */
export function GoalCompletionNotice({ status, onChoose }: { status: GoalStatus; onChoose: () => void }) {
    return <View style={styles.completionInset}>
        <AppNotice tone="success" style={styles.completionNotice} testID="goal-completion-notice">
            <AppText variant="section" accessibilityRole="header" aria-level={2}>Goal reached</AppText>
            {status.goal?.completed_on && <AppText variant="body">Trend reached your target on {formatDateOnlyForDisplay(status.goal.completed_on)}.</AppText>}
            {status.tracking && status.target_kcal != null && <AppText variant="muted">
                Your previous plan of {status.target_kcal.toLocaleString()} kcal/day stays in effect until you choose your next goal.
            </AppText>}
            <AppButton title="Choose your next goal" style={styles.completionAction} onPress={onChoose} />
        </AppNotice>
    </View>;
}

/** Celebrate the completed target and open the goal editor at the selected starting direction. */
export function NextGoalChoices({ status, onClose }: {
    status: GoalStatus;
    onClose: () => void;
}) {
    const weight = (grams: number) => formatWeight(Number(gramsToDisplayWeight(grams, status.weight_unit)), status.weight_unit);
    const reachedWeight = status.goal ? weight(status.goal.target_weight_grams) : null;
    const currentTrend = status.evidence === 'current' && status.trend ? weight(status.trend.weight_grams) : null;
    const recovery = status.recovery_range;
    const title = reachedWeight ? `You reached your ${reachedWeight} goal!` : 'You reached your weight goal!';
    const trendContext = currentTrend && currentTrend !== reachedWeight ? `Your trend is now ${currentTrend}. ` : '';
    let maintenanceChoice = reachedWeight ? 'Maintain a range around your goal weight' : 'Maintain a weight range';
    if (recovery) {
        maintenanceChoice = `Return to your saved range of ${weight(recovery.lower_weight_grams)} to ${weight(recovery.upper_weight_grams)}`;
    }
    function openSetup(maintain: boolean) {
        onClose();
        router.push(maintain ? { pathname: '/goal-setup', params: { mode: 'maintain' } } : '/goal-setup');
    }

    return <BottomSheetModal visible title={title} titleVariant="page"
        pinHeader showCloseButton closeAccessibilityLabel="Close goal choices" onRequestClose={onClose}>
        <AppText variant="muted">
            {`${trendContext}${maintenanceChoice} with optional calorie tracking, or set a new target and pace.`}
        </AppText>
        <View style={styles.choiceActions}>
            <AppButton title={recovery ? 'Resume maintenance' : 'Maintain this weight'}
                onPress={() => openSetup(true)} />
            <AppButton title="Set new goal target" variant="secondary" onPress={() => openSetup(false)} />
            <AppButton title="Decide later" variant="ghost" onPress={onClose} />
        </View>
    </BottomSheetModal>;
}

const styles = StyleSheet.create({
    completionInset: { paddingVertical: spacing.lg },
    completionNotice: { padding: spacing.lg, gap: spacing.sm },
    completionAction: { alignSelf: 'flex-start', maxWidth: '100%', marginTop: spacing.xs },
    choiceActions: { gap: spacing.sm }
});
