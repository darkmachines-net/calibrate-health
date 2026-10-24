/** @file activity: Presents imported activity for a selected local date without adding it to the calorie target. */

import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { ACTIVITY_RECORD_TYPES, WEIGHT_UNITS, type WeightUnit } from '@calibrate/shared';
import type { ActivityRecordEntry } from '@calibrate/api-client';
import {
    formatActivitySource,
    getActivitySourceLabels,
    hasImportedActivity
} from '../../../src/activity/presentation';
import {
    ActivitySummaryCard,
    type ActivityDay
} from '../../../src/components/ActivitySummaryCard';
import {
    AsyncStateBoundary,
    useAsyncResourceState,
    useOnlineStatus
} from '../../../src/components/AsyncStateBoundary';
import { AppSection } from '../../../src/components/AppSection';
import { AppActionRow } from '../../../src/components/AppActionRow';
import { AppText } from '../../../src/components/AppText';
import { DateNavigationHeader } from '../../../src/components/DateNavigationHeader';
import { HealthConnectConnectionAction } from '../../../src/components/HealthConnectConnectionAction';
import { SectionHeader } from '../../../src/components/SectionHeader';
import { TabScreen } from '../../../src/components/TabScreen';
import type { HealthConnectPresentation } from '../../../src/healthConnect/presentation';
import { useHealthConnectPresentation } from '../../../src/healthConnect/useHealthConnectPresentation';
import { useAuth } from '../../../src/auth/AuthContext';
import { useLogDateNavigation } from '../../../src/hooks/useLogDateNavigation';
import { spacing, useAppTheme, type AppTheme } from '../../../src/theme';
import { addDaysToDateOnly, formatDateOnlyForDisplay } from '../../../src/utils/dates';
import { gramsToDisplayWeight } from '../../../src/utils/bodyMeasurements';
import { formatCalories, formatNumber, formatWeightUnit } from '../../../src/utils/format';

const HISTORY_DAY_COUNT = 14; // Keep recent context useful on a phone without loading the full activity archive.

function formatDuration(record: ActivityRecordEntry): string {
    if (!record.end_time) return 'Duration unavailable';
    const start = new Date(record.start_time);
    const end = new Date(record.end_time);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 'Duration unavailable';
    const minutes = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000));
    return minutes.toLocaleString() + ' min';
}

function formatExerciseTime(record: ActivityRecordEntry): string {
    const start = new Date(record.start_time);
    if (Number.isNaN(start.getTime())) return record.start_time;
    return start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function formatImportedAt(day: ActivityDay | null | undefined): string {
    const timestamps = [
        day?.summary?.observed_at,
        ...(day?.records ?? []).map((record) => record.source_updated_at)
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);
    if (timestamps.length === 0) return 'Not imported yet';
    timestamps.sort();
    const parsed = new Date(timestamps[timestamps.length - 1]);
    return Number.isNaN(parsed.getTime()) ? 'Sync time unavailable' : parsed.toLocaleString();
}

function ActivityConnectionState({
    presentation,
    standalone
}: {
    presentation: HealthConnectPresentation;
    standalone: boolean;
}) {
    const theme = useAppTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    let color: string = theme.colors.onSurfaceVariant;
    let icon: React.ComponentProps<typeof Ionicons>['name'] = 'fitness-outline';
    if (presentation.tone === 'positive') {
        color = theme.colors.success;
        icon = 'checkmark-circle-outline';
    } else if (presentation.tone === 'caution') {
        color = theme.colors.warning;
        icon = 'time-outline';
    } else if (presentation.tone === 'danger') {
        color = theme.colors.danger;
        icon = 'alert-circle-outline';
    }

    return (
        <AppSection testID="activity-connection-state">
            {standalone && (
                <SectionHeader
                    title="No activity imported yet"
                    description="Health Connect is the optional source for read-only activity."
                />
            )}
            <View style={styles.connectionRow}>
                <Ionicons name={icon} size={22} color={color} />
                <AppText
                    accessibilityLiveRegion="polite"
                    accessibilityRole={presentation.tone === 'danger' ? 'alert' : undefined}
                    style={[styles.connectionCopy, { color }]}
                >
                    {presentation.message}
                </AppText>
            </View>
            <HealthConnectConnectionAction variant={standalone ? 'primary' : 'secondary'} />
            {standalone && (
                <AppText variant="muted">
                    Imported activity never automatically changes your calorie target.
                </AppText>
            )}
        </AppSection>
    );
}

function ExerciseSessions({ records }: { records: ActivityRecordEntry[] }) {
    const theme = useAppTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    if (records.length === 0) return null;

    return (
        <AppSection style={styles.dividedSection}>
            <SectionHeader title="Exercise sessions" />
            {records.map((record) => (
                <View key={record.id} style={styles.exerciseRow}>
                    <View style={styles.exerciseIcon}>
                        <Ionicons name="fitness-outline" size={20} color={theme.colors.primary} />
                    </View>
                    <View style={styles.exerciseText}>
                        <AppText style={styles.exerciseTitle}>
                            {record.title?.trim() || 'Exercise session'}
                        </AppText>
                        <AppText variant="caption">
                            {formatExerciseTime(record) + ' | ' + formatDuration(record)}
                        </AppText>
                    </View>
                </View>
            ))}
        </AppSection>
    );
}

function ActivityDetailsDisclosure({
    day,
    weightUnit
}: {
    day: ActivityDay | null | undefined;
    weightUnit: WeightUnit;
}) {
    const theme = useAppTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    const [expanded, setExpanded] = useState(false);
    const records = day?.records ?? [];
    const weightRecords = records.filter(
        (record) => record.record_type === ACTIVITY_RECORD_TYPES.WEIGHT && record.weight_grams !== null
    );
    const sources = getActivitySourceLabels(records);

    return (
        <AppSection testID="activity-details" style={styles.dividedSection}>
            <Pressable
                testID="activity-details-toggle"
                accessibilityRole="button"
                accessibilityLabel={expanded ? 'Hide activity details' : 'Show activity details'}
                accessibilityState={{ expanded }}
                onPress={() => setExpanded((current) => !current)}
                style={({ pressed }) => [styles.detailsToggle, pressed && styles.pressed]}
            >
                <AppText style={styles.detailsTitle}>Details</AppText>
                <Ionicons
                    name={expanded ? 'chevron-up' : 'chevron-down'}
                    size={20}
                    color={theme.colors.onSurfaceVariant}
                />
            </Pressable>
            {expanded && (
                <View testID="activity-details-content" style={styles.detailsContent}>
                    <View style={styles.detailSection}>
                        <AppText variant="label">Sources and sync</AppText>
                        <AppText>{sources.join(', ')}</AppText>
                        <AppText variant="caption">Last imported: {formatImportedAt(day)}</AppText>
                        <AppText variant="muted">
                            Connected apps may revise totals as synchronization and record reconciliation finish.
                        </AppText>
                    </View>
                    <View style={styles.detailSection}>
                        <AppText variant="label">Imported weight</AppText>
                        {weightRecords.length === 0 ? (
                            <AppText variant="muted">No imported weight for this day.</AppText>
                        ) : weightRecords.map((record) => {
                            const displayWeight = gramsToDisplayWeight(record.weight_grams, weightUnit);
                            const device = [record.device_manufacturer, record.device_model].filter(Boolean).join(' ');
                            return (
                                <View key={record.id} style={styles.weightRow}>
                                    <AppText style={styles.weightValue}>
                                        {String(displayWeight) + ' ' + formatWeightUnit(weightUnit)}
                                    </AppText>
                                    <AppText variant="caption">
                                        {'Source: ' + formatActivitySource(record.data_origin)}
                                    </AppText>
                                    {device ? <AppText variant="caption">{'Device: ' + device}</AppText> : null}
                                </View>
                            );
                        })}
                        <AppText variant="muted">
                            Imported weight is read only and never overwrites a manual weigh-in.
                        </AppText>
                    </View>
                    <View style={styles.detailSection}>
                        <AppText variant="label">How totals affect your target</AppText>
                        <AppText variant="muted">
                            Device-estimated total burn comes from connected health apps. Calibrate keeps using your
                            profile estimate for its calorie target.
                        </AppText>
                        <AppText style={styles.targetGuardrail}>
                            Imported activity never automatically changes your calorie target.
                        </AppText>
                    </View>
                </View>
            )}
        </AppSection>
    );
}

/** Presents imported activity for a selected local date without adding it to the calorie target. */
export default function ActivityScreen() {
    const theme = useAppTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    const { date } = useLocalSearchParams<{ date?: string }>();
    const { api, user } = useAuth();
    const navigation = useLogDateNavigation(typeof date === 'string' ? date : null);
    const historyStart = useMemo(() => {
        const candidate = addDaysToDateOnly(navigation.today, -(HISTORY_DAY_COUNT - 1));
        return candidate < navigation.minDate ? navigation.minDate : candidate;
    }, [navigation.minDate, navigation.today]);
    const selectedQuery = useQuery({
        queryKey: ['mobile-activity-days', navigation.selectedDate, navigation.selectedDate],
        queryFn: () => api.getActivityDays({ start: navigation.selectedDate, end: navigation.selectedDate })
    });
    const historyQuery = useQuery({
        queryKey: ['mobile-activity-days', historyStart, navigation.today],
        queryFn: () => api.getActivityDays({ start: historyStart, end: navigation.today })
    });
    const isOnline = useOnlineStatus();
    const selectedState = useAsyncResourceState(selectedQuery, (data) => data.days.length === 0);
    const historyState = useAsyncResourceState(historyQuery, (data) => data.days.length === 0);
    const selectedDay = selectedQuery.data?.days[0];
    const selectedRecords = selectedDay?.records ?? [];
    const exerciseRecords = selectedRecords.filter(
        (record) => record.record_type === ACTIVITY_RECORD_TYPES.EXERCISE_SESSION
    );
    const historyDays = (historyQuery.data?.days ?? []).slice().reverse();
    const importedDataExists = hasImportedActivity([
        ...(selectedQuery.data?.days ?? []),
        ...(historyQuery.data?.days ?? [])
    ]);
    const healthConnectPresentation = useHealthConnectPresentation({
        hasImportedActivity: importedDataExists
    });
    const showConnectionNotice = healthConnectPresentation.state !== 'ready'
        && healthConnectPresentation.state !== 'empty';

    const recentDaysLoading = (
        <AppSection testID="activity-recent-days" style={styles.dividedSection}>
            <SectionHeader title="Recent Days" />
            <AppText variant="muted">Loading recent activity...</AppText>
        </AppSection>
    );
    const recentDaysEmpty = (
        <AppSection testID="activity-recent-days" style={styles.dividedSection}>
            <SectionHeader title="Recent Days" />
            <AppText variant="muted">No imported activity was found in the latest 14 days.</AppText>
        </AppSection>
    );

    return (
        <View style={styles.screen}>
            <DateNavigationHeader navigation={navigation} contentWidth="overview" />
            <TabScreen contentWidth="overview">
                {showConnectionNotice && (
                    <ActivityConnectionState
                        presentation={healthConnectPresentation}
                        standalone={!healthConnectPresentation.shouldShowActivity}
                    />
                )}
                {healthConnectPresentation.shouldShowActivity ? (
                    <>
                        <SectionHeader
                            title={navigation.isToday
                                ? 'Today'
                                : formatDateOnlyForDisplay(navigation.selectedDate)}
                            description="Read-only activity reported by connected health apps."
                        />
                        <AsyncStateBoundary
                            state={selectedState}
                            resourceLabel="selected-day activity"
                            loading={(
                                <ActivitySummaryCard
                                    day={undefined}
                                    isToday={navigation.isToday}
                                    isLoading
                                />
                            )}
                            empty={(
                                <>
                                    <ActivitySummaryCard day={undefined} isToday={navigation.isToday} />
                                    <ActivityDetailsDisclosure
                                        key={navigation.selectedDate}
                                        day={undefined}
                                        weightUnit={user?.weight_unit ?? WEIGHT_UNITS.KG}
                                    />
                                </>
                            )}
                            onRetry={isOnline ? () => selectedQuery.refetch() : undefined}
                            retrying={selectedQuery.isFetching}
                        >
                            <>
                                <ActivitySummaryCard day={selectedDay} isToday={navigation.isToday} />
                                <ExerciseSessions records={exerciseRecords} />
                                <ActivityDetailsDisclosure
                                    key={selectedDay?.local_date ?? navigation.selectedDate}
                                    day={selectedDay}
                                    weightUnit={user?.weight_unit ?? WEIGHT_UNITS.KG}
                                />
                            </>
                        </AsyncStateBoundary>
                        <AsyncStateBoundary
                            state={historyState}
                            resourceLabel="recent activity"
                            loading={recentDaysLoading}
                            empty={recentDaysEmpty}
                            onRetry={isOnline ? () => historyQuery.refetch() : undefined}
                            retrying={historyQuery.isFetching}
                        >
                            <AppSection testID="activity-recent-days" style={styles.dividedSection}>
                                <SectionHeader
                                    title="Recent Days"
                                    description="Select a day to inspect its imported activity."
                                />
                                {historyDays.map((day) => (
                                    <AppActionRow
                                        key={day.local_date}
                                        accessibilityRole="button"
                                        accessibilityLabel={
                                            'View activity for ' + formatDateOnlyForDisplay(day.local_date)
                                        }
                                        onPress={() => navigation.setDate(day.local_date)}
                                        selected={day.local_date === navigation.selectedDate}
                                        style={styles.historyRecord}
                                        contentStyle={styles.historyRow}
                                    >
                                        <View style={styles.historyContent}>
                                            <View style={styles.historyDate}>
                                                <AppText style={styles.exerciseTitle}>
                                                    {formatDateOnlyForDisplay(day.local_date)}
                                                </AppText>
                                                <AppText variant="caption">
                                                    {day.summary
                                                        ? formatNumber(day.summary.exercise_minutes, 0) + ' exercise min'
                                                        : 'No imported summary'}
                                                </AppText>
                                            </View>
                                            <View style={styles.historyMetrics}>
                                                <AppText>
                                                    {formatNumber(day.summary?.steps, 0) + ' steps'}
                                                </AppText>
                                                <AppText variant="caption">
                                                    {formatCalories(day.summary?.active_calories_kcal) + ' active'}
                                                </AppText>
                                            </View>
                                        </View>
                                        <Ionicons
                                            name="chevron-forward"
                                            size={18}
                                            color={theme.colors.onSurfaceVariant}
                                        />
                                    </AppActionRow>
                                ))}
                            </AppSection>
                        </AsyncStateBoundary>
                    </>
                ) : null}
            </TabScreen>
        </View>
    );
}

const createStyles = (theme: AppTheme) => StyleSheet.create({
    screen: {
        flex: 1
    },
    dividedSection: {
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.outlineVariant,
        paddingTop: spacing.lg
    },
    connectionRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: spacing.sm
    },
    connectionCopy: {
        flex: 1
    },
    exerciseRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingVertical: spacing.sm,
        borderBottomColor: theme.colors.outlineVariant,
        borderBottomWidth: StyleSheet.hairlineWidth
    },
    exerciseIcon: {
        width: spacing.lg,
        height: spacing.lg,
        alignItems: 'center',
        justifyContent: 'center'
    },
    exerciseText: {
        flex: 1,
        gap: spacing.xs
    },
    exerciseTitle: {
        fontWeight: '600'
    },
    detailsToggle: {
        minHeight: theme.interaction.minimumTouchTarget,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.md
    },
    detailsTitle: {
        ...theme.typography.styles.section
    },
    detailsContent: {
        gap: spacing.lg
    },
    detailSection: {
        gap: spacing.xs
    },
    weightRow: {
        gap: spacing.xs,
        paddingVertical: spacing.sm,
        borderBottomColor: theme.colors.outlineVariant,
        borderBottomWidth: StyleSheet.hairlineWidth
    },
    weightValue: {
        ...theme.typography.styles.measurement,
        fontVariant: ['tabular-nums']
    },
    targetGuardrail: {
        fontWeight: '600'
    },
    historyRecord: {
        borderBottomColor: theme.colors.outlineVariant,
        borderBottomWidth: StyleSheet.hairlineWidth
    },
    historyRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingHorizontal: spacing.sm
    },
    historyContent: {
        flex: 1,
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: spacing.sm
    },
    historyDate: {
        flexGrow: 1,
        flexBasis: 120,
        gap: spacing.xs
    },
    historyMetrics: {
        flexGrow: 1,
        flexBasis: 120,
        alignItems: 'flex-start',
        gap: spacing.xs
    },
    pressed: {
        opacity: 0.78
    }
});
