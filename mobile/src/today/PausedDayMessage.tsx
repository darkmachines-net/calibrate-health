/** @file Paused Day Message: Explains paused tracking and its expected resume date without implying automatic resumption. */

import React from 'react';
import { StyleSheet, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { AppText } from '../components/AppText';
import { FixedPageColumn } from '../components/FixedPage';
import { type AppTheme, useAppTheme } from '../theme';
import { useAuth } from '../auth/AuthContext';
import { useCurrentLocalDate } from '../hooks/useCurrentLocalDate';
import { useFoodTrackingPause } from '../food/useFoodTrackingPause';
import { getActivePausePlan, getPauseExpectationCopy } from '../food/plannedPause';
import { useOnlineStatus } from '../components/AsyncStateBoundary';

const PAUSE_SYMBOL_SIZE = 80; // Anchors the paused day in the space normally used for calorie tracking.
const PAUSE_GLYPH_SIZE = 36; // Keeps the pause symbol legible without competing with the heading.
const MESSAGE_MAX_WIDTH = 440; // Keeps centered explanatory copy readable on wide screens.

/** Explains paused tracking and its expected resume date without implying automatic resumption. */
export function PausedDayMessage({ isToday }: { isToday: boolean }) {
    const theme = useAppTheme();
    const styles = React.useMemo(() => createStyles(theme), [theme]);
    const { user } = useAuth();
    const pauseQuery = useFoodTrackingPause(isToday);
    const isOnline = useOnlineStatus();
    const today = useCurrentLocalDate(user?.timezone);
    const expectation = isToday ? getPauseExpectationCopy(getActivePausePlan(pauseQuery.data?.pause, today), today) : null;
    let metadataNotice: string | null = null;
    if (isToday) {
        if (!isOnline) metadataNotice = expectation ? 'Offline - showing saved pause plan.' : 'Pause plan unavailable offline.';
        else if (pauseQuery.isError) metadataNotice = expectation ? 'Could not refresh the saved pause plan.' : 'Pause plan unavailable.';
        else if (pauseQuery.isPending) metadataNotice = 'Loading pause plan...';
        else if (pauseQuery.data?.pause.active && !expectation) metadataNotice = 'Pause plan unavailable.';
    }

    return <FixedPageColumn testID="paused-day-message" style={styles.region}>
        <View style={styles.message}>
            <View style={styles.symbol} aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                <Ionicons name="pause" size={PAUSE_GLYPH_SIZE} color={theme.colors.onPrimaryContainer} />
            </View>
            <AppText variant="label" style={[styles.eyebrow, styles.centered]}>{expectation ?? (isToday ? 'Taking a break' : 'A day on pause')}</AppText>
            <AppText accessibilityRole="header" aria-level={1} variant="title" style={styles.centered}>
                {isToday ? 'Tracking paused' : 'Tracking was paused'}
            </AppText>
            {metadataNotice && <AppText variant="caption" accessibilityLiveRegion="polite" style={styles.centered}>{metadataNotice}</AppText>}
            <AppText variant="body" style={styles.description}>
                {isToday
                    ? 'Food logging, calorie targets, and reminders are on pause. Resume whenever you are ready.'
                    : 'Food and calorie tracking were paused for this day. It is not counted as a zero-calorie day.'}
            </AppText>
            <View style={styles.supportingCopy}>
                <AppText variant="body" style={styles.centered}>Weight logging is always available.</AppText>
                <AppText variant="muted" style={styles.centered}>
                    {isToday
                        ? 'Your goal and logged history are still here.'
                        : 'Use Edit day if you want to backfill your food log.'}
                </AppText>
            </View>
        </View>
    </FixedPageColumn>;
}

function createStyles(theme: AppTheme) {
    return StyleSheet.create({
        region: { flexGrow: 1, justifyContent: 'center', paddingVertical: theme.spacing.xxl },
        message: { width: '100%', maxWidth: MESSAGE_MAX_WIDTH, alignSelf: 'center', alignItems: 'center', gap: theme.spacing.md },
        symbol: { width: PAUSE_SYMBOL_SIZE, height: PAUSE_SYMBOL_SIZE, borderRadius: theme.radius.pill, backgroundColor: theme.colors.primaryContainer, alignItems: 'center', justifyContent: 'center', marginBottom: theme.spacing.sm },
        eyebrow: { color: theme.colors.primary },
        centered: { textAlign: 'center' },
        description: { textAlign: 'center', color: theme.colors.onSurfaceVariant },
        supportingCopy: { width: '100%', gap: theme.spacing.sm, paddingTop: theme.spacing.lg }
    });
}
