/** @file Plan Check Summary: A stable diagnosis slot; expanded details own review, apply, and undo actions. */

import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery } from '@tanstack/react-query';
import type { CalibrationStatusResponse } from '@calibrate/api-client';
import { useAuth } from '../../auth/AuthContext';
import { calibrationStatusQueryKey } from '../../calibration/queryKeys';
import { paceIcon, paceTitle, waitingTitle } from '../../calibration/planCheckPresentation';
import { usePendingCalibrationEvidenceMutation } from '../../offline/usePendingCalibrationEvidenceMutation';
import { dateOnlyToLocalDate } from '../../utils/dates';
import { useAppTheme, type AppTheme } from '../../theme';
import { AppText } from '../AppText';
import { FixedPageColumn } from '../FixedPage';
import { useOnlineStatus } from '../AsyncStateBoundary';
import { useFocusVisible } from '../useFocusVisible';

type PlanCheckSummaryProps = {
    onPress: () => void;
    planAvailable?: boolean;
};

type PlanCheckSummaryViewProps = PlanCheckSummaryProps & {
    status?: CalibrationStatusResponse;
    pendingEvidence?: boolean;
    isLoading?: boolean;
    error?: boolean;
    offline?: boolean;
};

type SummaryPresentation = {
    metadata: string;
    diagnosis: string;
    icon: React.ComponentProps<typeof Ionicons>['name'];
    tone: 'muted' | 'success' | 'warning';
};

function presentSummary({ status, pendingEvidence, planAvailable, isLoading, error, offline }: PlanCheckSummaryViewProps): SummaryPresentation {
    if (pendingEvidence) return {
        metadata: 'Updating after your entries sync',
        diagnosis: 'Your latest food and weight entries are syncing.',
        icon: 'sync-outline', tone: 'muted'
    };
    if (planAvailable === false || status?.planStatus === 'requires_review') return {
        metadata: 'Calorie plan unavailable',
        diagnosis: 'Review your calorie plan to restart this check.',
        icon: 'information-circle-outline', tone: 'warning'
    };
    if (!status && (error || offline)) return {
        metadata: offline ? 'Offline' : 'Unable to update',
        diagnosis: offline ? 'Reconnect to load your plan check.' : 'Open details to retry your plan check.',
        icon: offline ? 'cloud-offline-outline' : 'alert-circle-outline', tone: 'muted'
    };
    if (isLoading || !status?.evaluation) return {
        metadata: 'Checking your latest completed day',
        diagnosis: 'Building your plan check...',
        icon: 'time-outline', tone: 'muted'
    };
    if (status.scheduledChange) return {
        metadata: 'Saved calorie target update',
        diagnosis: status.scheduledChange.dailyCalorieBudgetKcal === null
            ? 'Your saved update is on hold. Open details to review it.'
            : 'A calorie target update is scheduled. Open details to review or undo it.',
        icon: status.scheduledChange.dailyCalorieBudgetKcal === null ? 'time-outline' : 'checkmark-circle-outline',
        tone: status.scheduledChange.dailyCalorieBudgetKcal === null ? 'warning' : 'success'
    };
    const assessment = status.evaluation.assessment;
    if (!assessment) return {
        metadata: 'Check unavailable',
        diagnosis: 'This check is not available from your connected server yet.',
        icon: 'information-circle-outline', tone: 'muted'
    };
    const date = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
        .format(dateOnlyToLocalDate(assessment.window?.endDate ?? status.evaluation.asOfDate));
    const metadata = assessment.window ? `${assessment.window.spanDays} days through ${date}` : `Updated through ${date}`;
    if (assessment.state === 'waiting') return {
        metadata,
        diagnosis: waitingTitle(assessment.blocker),
        icon: 'time-outline', tone: 'muted'
    };
    if (!assessment.paceStatus) return {
        metadata, diagnosis: 'Your plan check is still taking shape.', icon: 'time-outline', tone: 'muted'
    };
    return {
        metadata,
        diagnosis: paceTitle(assessment.paceStatus),
        icon: paceIcon(assessment.paceStatus),
        tone: assessment.paceStatus === 'aligned' ? 'success' : 'warning'
    };
}

/** A stable diagnosis slot; expanded details own review, apply, and undo actions. */
export function PlanCheckSummary({ onPress, planAvailable }: PlanCheckSummaryProps) {
    const { api } = useAuth();
    const statusQuery = useQuery({
        queryKey: calibrationStatusQueryKey,
        queryFn: () => api.getCalibrationStatus(),
        enabled: planAvailable !== false
    });
    const pendingEvidence = usePendingCalibrationEvidenceMutation();
    const isOnline = useOnlineStatus();
    return <PlanCheckSummaryView
        onPress={onPress}
        planAvailable={planAvailable}
        status={statusQuery.data}
        isLoading={statusQuery.isLoading}
        error={statusQuery.isError}
        offline={!isOnline}
        pendingEvidence={pendingEvidence}
    />;
}

/** Presents a compact plan-check state with focus feedback and stale-refresh handling. */
export function PlanCheckSummaryView(props: PlanCheckSummaryViewProps) {
    const theme = useAppTheme();
    const styles = React.useMemo(() => createStyles(theme), [theme]);
    const { focusVisible, handleFocus, handleBlur } = useFocusVisible();
    const [hovered, setHovered] = React.useState(false);
    const presentation = presentSummary(props);
    const showingFailedRefresh = props.error && props.status && !props.pendingEvidence && props.planAvailable !== false;
    const metadata = showingFailedRefresh ? 'Could not refresh | Showing saved check' : presentation.metadata;
    const colors = { muted: theme.colors.onSurfaceVariant, success: theme.colors.success, warning: theme.colors.warning };
    return <Pressable
        testID="plan-check-summary"
        accessibilityLabel={`Open plan check details. ${presentation.diagnosis}`}
        accessibilityHint={metadata}
        accessibilityRole="button"
        onPress={props.onPress}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        style={({ pressed }) => [styles.root, hovered && styles.hovered, pressed && styles.pressed, focusVisible && styles.focusVisible]}
    >
        <FixedPageColumn style={styles.content}>
            <View style={styles.heading}>
                <View style={styles.headingCopy}>
                    <AppText variant="section" accessibilityRole="header">Plan check</AppText>
                    <AppText variant="muted">{metadata}</AppText>
                </View>
                <View accessible={false} aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                    <Ionicons name="expand-outline" size={20} color={theme.colors.primary} />
                </View>
            </View>
            <View style={styles.diagnosis}>
                <Ionicons name={presentation.icon} size={22} color={colors[presentation.tone]} />
                <AppText style={styles.diagnosisText}>{presentation.diagnosis}</AppText>
            </View>
        </FixedPageColumn>
    </Pressable>;
}

function createStyles(theme: AppTheme) {
    return StyleSheet.create({
        // Keep the heading close to the rule and let wrapped or enlarged copy grow naturally.
        root: { paddingVertical: theme.spacing.lg },
        content: { gap: theme.spacing.sm },
        heading: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
        headingCopy: { flex: 1, minWidth: 0, gap: theme.spacing.xs },
        hovered: { backgroundColor: theme.colors.surfaceHovered },
        pressed: { backgroundColor: theme.colors.surfacePressed },
        focusVisible: { outlineWidth: theme.interaction.focusRingWidth, outlineColor: theme.colors.focusRing, outlineStyle: 'solid' },
        diagnosis: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing.sm },
        diagnosisText: { flex: 1, minWidth: 0, fontWeight: '500' }
    });
}
