/** @file Compact descriptive progress summary and entry point to tracking windows and weekly reports. */

import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery } from '@tanstack/react-query';
import type { PlanCheckResponse } from '@calibrate/api-client';
import { useAuth } from '../../auth/AuthContext';
import { calibrationStatusQueryKey } from '../../calibration/queryKeys';
import { useCurrentLocalDate } from '../../hooks/useCurrentLocalDate';
import { usePendingCalibrationEvidenceMutation } from '../../offline/usePendingCalibrationEvidenceMutation';
import { useAppTheme, type AppTheme } from '../../theme';
import { AppText } from '../AppText';
import { FixedPageColumn } from '../FixedPage';
import { useOnlineStatus } from '../AsyncStateBoundary';
import { useFocusVisible } from '../useFocusVisible';

type PlanCheckSummaryProps = {
    onPress: () => void;
};

type PlanCheckSummaryViewProps = PlanCheckSummaryProps & {
    status?: PlanCheckResponse;
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

function presentSummary({ status, pendingEvidence, isLoading, error, offline }: PlanCheckSummaryViewProps): SummaryPresentation {
    if (pendingEvidence) return {
        metadata: 'Updating after your entries sync', diagnosis: 'Your latest food and weight entries are syncing.',
        icon: 'sync-outline', tone: 'muted'
    };
    if (!status && (error || offline)) return {
        metadata: offline ? 'Offline' : 'Unable to update',
        diagnosis: offline ? 'Reconnect to load your progress summary.' : 'Open details to retry your progress summary.',
        icon: 'cloud-offline-outline', tone: 'muted'
    };
    if (isLoading || !status) return {
        metadata: 'Recent tracking', diagnosis: 'Loading your progress summary...', icon: 'time-outline', tone: 'muted'
    };
    if (status.windows.length === 0) return {
        metadata: 'Getting started', diagnosis: 'Your first trend summary appears after 7 days of tracking.',
        icon: 'time-outline', tone: 'muted'
    };
    if (status.needsWeighIn) return {
        metadata: 'A recent weigh-in is needed', diagnosis: 'Log your weight today to restore weight trends.',
        icon: 'scale-outline', tone: 'muted'
    };
    const durations = status.windows.map(window => window.days).join(', ');
    return {
        metadata: 'Last ' + durations + ' days',
        diagnosis: status.weeklyReports.length ? 'Your weekly report and recent trends are ready.' : 'Explore your weight changes and food-log coverage.',
        icon: 'stats-chart-outline', tone: 'muted'
    };
}

/** Load the descriptive summary independently of calorie-plan availability. */
export function PlanCheckSummary({ onPress }: PlanCheckSummaryProps) {
    const { api, user } = useAuth();
    const localDate = useCurrentLocalDate(user?.timezone);
    const statusQuery = useQuery({
        queryKey: [...calibrationStatusQueryKey, localDate],
        queryFn: () => api.getPlanCheck()
    });
    const pendingEvidence = usePendingCalibrationEvidenceMutation();
    const isOnline = useOnlineStatus();
    return <PlanCheckSummaryView
        onPress={onPress}
        status={statusQuery.data}
        isLoading={statusQuery.isLoading}
        error={statusQuery.isError || statusQuery.failureReason != null}
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
    const showingFailedRefresh = props.error && props.status && !props.pendingEvidence;
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
