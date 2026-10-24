import { useFoodTrackingPause } from '../food/useFoodTrackingPause';
import { foodTrackingPauseQueryKey } from '../food/queryKeys';
import { queuedFoodDayStatus } from '../offline/foodDayIntent';
import { useScopedTrackingMutations } from '../offline/useTrackingQueries';
import React, { useEffect, useMemo, useState } from 'react';
import { AppState, StyleSheet, View, useWindowDimensions, type StyleProp, type ViewStyle } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FoodLogDay, FoodLogDayStatus, FoodTrackingPause } from '@calibrate/api-client';
import { useAuth } from '../auth/AuthContext';
import { executeOrQueueMutation, OFFLINE_MUTATION_OPERATIONS } from '../offline/operations';
import { useOfflineOutbox } from '../offline/provider';
import { foodDayRangeQueryRoot } from '../food/calendar';
import { FoodLogDockActions } from '../food/FoodLogDockActions';
import { getFoodDayStatusLabel } from '../food/dayPresentation';
import { calibrationStatusQueryKey } from '../calibration/queryKeys';
import { addDaysToDateOnly } from '../utils/dates';
import { useCurrentLocalDate } from '../hooks/useCurrentLocalDate';
import { type AppTheme, useAppTheme } from '../theme';
import { AppButton } from './AppButton';
import { AppSection } from './AppSection';
import { AppText } from './AppText';
import { BottomSheetModal } from './BottomSheetModal';
import { DatePickerField } from './DatePickerField';
import { SectionHeader } from './SectionHeader';
import { getSafeActionErrorMessage } from '../errors/presentation';

export const foodDayQueryKey = (date: string) => ['mobile-food-day', date] as const;


const EXPANDED_STATUS_CONTENT_MAX_WIDTH = 520; // Keeps the status message readable on wide dashboards.
const EXPANDED_STATUS_ACTION_MAX_WIDTH = 320; // Keeps the primary action prominent without spanning a desktop card.
const EXPANDED_STATUS_ICON_SIZE = 80; // Gives the full-height status treatment a clear visual anchor.
const EXPANDED_STATUS_GLYPH_SIZE = 38; // Scales the pause glyph with its expanded circular container.
const NARROW_DOCK_BREAKPOINT = 360; // Keep the icon and completed label on one line on a 320px phone.

function storedDay(date: string, status: FoodLogDayStatus): FoodLogDay {
    return {
        date,
        status,
        origin: 'USER',
        source: 'STORED',
        is_representative: status === 'COMPLETE',
        is_complete: status === 'COMPLETE',
        completed_at: null,
        updated_at: null
    };
}

function activePause(startsOn: string, expectedResumeOn: string | null): FoodTrackingPause {
    return {
        active: true,
        id: null,
        starts_on: startsOn,
        expected_resume_on: expectedResumeOn,
        resumed_on: null,
        started_at: null,
        resumed_at: null,
        materialized_through: startsOn,
        resume_confirmation_due: false
    };
}

function useRefreshTrackingState(date?: string) {
    const queryClient = useQueryClient();
    return async () => {
        await Promise.all([
            date ? queryClient.invalidateQueries({ queryKey: foodDayQueryKey(date) }) : Promise.resolve(),
            queryClient.invalidateQueries({ queryKey: foodDayRangeQueryRoot }),
            queryClient.invalidateQueries({ queryKey: foodTrackingPauseQueryKey }),
            queryClient.invalidateQueries({ queryKey: calibrationStatusQueryKey }),
            queryClient.invalidateQueries({ queryKey: ['mobile-in-app-notifications'] })
        ]);
    };
}

export function useFoodDayStatus(date: string, enabled = true) {
    const { api } = useAuth();
    const mutations = useScopedTrackingMutations();
    const { dayIntents = [], readFoodDay } = useOfflineOutbox();
    const query = useQuery({
        queryKey: foodDayQueryKey(date),
        queryFn: () => readFoodDay ? readFoodDay(date, () => api.getFoodDay(date)) : api.getFoodDay(date),
        enabled
    });
    let data = query.data;
    const status = queuedFoodDayStatus([...dayIntents, ...mutations].filter(row => row.state !== 'failed'), date, data?.status);
    if (status && status !== data?.status) data = storedDay(date, status);
    return { ...query, data };
}

export const DayStatusCard: React.FC<{
    date: string;
    isToday: boolean;
    failed?: boolean;
    loading?: boolean;
    stackActions?: boolean;
    compact?: boolean;
    expanded?: boolean;
    presentation?: 'section' | 'dock' | 'controls';
    onAddFood?: () => void;
    onActionComplete?: () => void;
    style?: StyleProp<ViewStyle>;
}> = ({ date, isToday, failed = false, loading = false, stackActions = false, compact = false, expanded = false, presentation = 'section', onAddFood, onActionComplete, style }) => {
    const { api } = useAuth();
    const { enqueue, withOutbox, mutations = [] } = useOfflineOutbox();
    const queryClient = useQueryClient();
    const theme = useAppTheme();
    const { width, fontScale } = useWindowDimensions();
    const styles = useMemo(() => createStyles(theme), [theme]);
    const dayQuery = useFoodDayStatus(date);
    const refresh = useRefreshTrackingState(date);
    const [pauseSheetOpen, setPauseSheetOpen] = useState(false);
    const [expectedResumeOn, setExpectedResumeOn] = useState('');
    const [showExpectedDate, setShowExpectedDate] = useState(false);

    const setStatus = useMutation({
        networkMode: 'always', // Persist local intent even when React Query knows the network is offline.
        mutationFn: (status: Exclude<FoodLogDayStatus, 'PAUSED'>) => {
            const payload = { date, status };
            const intent = status === 'OPEN' && !isToday && dayQuery.data?.status === 'PAUSED'
                ? { ...payload, explicitPausedBackfill: true } : payload;
            return executeOrQueueMutation({
                withOutbox,
                forceQueue: mutations.length > 0,
                operation: OFFLINE_MUTATION_OPERATIONS.SET_FOOD_DAY_STATUS,
                payload: intent,
                execute: (operationId) => api.setFoodDayStatus(payload, operationId),
                enqueue
            });
        },
        onSuccess: async (result, status) => {
            const day = result.disposition === 'synced' ? result.value : storedDay(date, status);
            queryClient.setQueryData(foodDayQueryKey(date), day);
            await refresh();
        }
    });

    const startPause = useMutation({
        networkMode: 'always', // Persist local intent even when React Query knows the network is offline.
        mutationFn: (resumeOn: string | null) => {
            const payload = { starts_on: date, expected_resume_on: resumeOn };
            return executeOrQueueMutation({
                withOutbox,
                forceQueue: mutations.length > 0,
                operation: OFFLINE_MUTATION_OPERATIONS.START_FOOD_TRACKING_PAUSE,
                payload,
                execute: (operationId) => api.startFoodTrackingPause(payload, operationId),
                enqueue
            });
        },
        onSuccess: async (result, resumeOn) => {
            queryClient.setQueryData(foodDayQueryKey(date), {
                ...storedDay(date, 'PAUSED'),
                origin: 'PAUSE'
            });
            const pause = result.disposition === 'synced'
                ? result.value.pause
                : activePause(date, resumeOn);
            queryClient.setQueryData(foodTrackingPauseQueryKey, { pause });
            setPauseSheetOpen(false);
            setShowExpectedDate(false);
            setExpectedResumeOn('');
            onActionComplete?.();
            await refresh();
        }
    });

    const resume = useMutation({
        networkMode: 'always', // Persist local intent even when React Query knows the network is offline.
        mutationFn: () => {
            const payload = { resumed_on: date };
            return executeOrQueueMutation({
                withOutbox,
                forceQueue: mutations.length > 0,
                operation: OFFLINE_MUTATION_OPERATIONS.RESUME_FOOD_TRACKING,
                payload,
                execute: (operationId) => api.resumeFoodTracking(payload, operationId),
                enqueue
            });
        },
        onSuccess: async () => {
            queryClient.setQueryData(foodDayQueryKey(date), storedDay(date, 'OPEN'));
            queryClient.setQueryData(foodTrackingPauseQueryKey, {
                pause: { ...activePause(date, null), active: false, starts_on: null, materialized_through: null }
            });
            await refresh();
        }
    });

    if (dayQuery.isLoading || !dayQuery.data) {
        return null;
    }

    const day = dayQuery.data;
    const useCompactOpenLayout = compact && isToday && day.status === 'OPEN';
    const useExpandedPauseLayout = expanded && isToday && day.status === 'PAUSED';
    const isBusy = loading || setStatus.isPending || startPause.isPending || resume.isPending;
    const actionError = setStatus.error ?? startPause.error ?? resume.error;
    const statusFailed = failed || dayQuery.isError;
    const stackDockActions = stackActions || fontScale >= 1.6;
    const dockActionStyle = [styles.dockAction, width < NARROW_DOCK_BREAKPOINT && styles.dockActionNarrow, stackDockActions && styles.dockActionStacked];
    const dockLabelStyle = [styles.dockLabel, width < NARROW_DOCK_BREAKPOINT && styles.dockNarrowLabel];
    const confirmedComplete = day.status === 'COMPLETE' && !statusFailed && !loading;
    const completedForeground = theme.mode === 'dark' ? theme.colors.onPrimaryContainer : theme.colors.onPrimary;
    let icon: React.ComponentProps<typeof Ionicons>['name'] = 'options-outline';
    const title = getFoodDayStatusLabel({ status: day.status, failed: statusFailed });
    let description = isToday
        ? 'Add the rest of your meals to complete your day.'
        : 'This day remains unresolved until its calorie log represents the full day.';
    if (statusFailed && day.status !== 'PAUSED') {
        icon = 'alert-circle-outline';
        description = dayQuery.isError
            ? 'Day status could not be refreshed, so this day is not treated as fully logged.'
            : 'Today data could not be refreshed, so this day is not treated as fully logged.';
    } else if (day.status === 'COMPLETE') {
        icon = 'checkmark-circle';
        description = 'This is a signed-off full-day calorie record.';
    } else if (day.status === 'INCOMPLETE') {
        icon = 'alert-circle-outline';
        description = day.source === 'INFERRED_EMPTY'
            ? 'No food was logged for this past day, so it is not treated as a zero-calorie day.'
            : 'Calories are shown as raw entries and are not treated as a complete day.';
    } else if (day.status === 'PAUSED') {
        icon = 'pause-circle';
        description = 'Food targets and reminders are paused. Your goal remains active, and you can still enter weight voluntarily.';
    } else if (!isToday) {
        icon = 'help-circle-outline';
        description = 'This past day has some tracking data but was never signed off as complete or incomplete.';
    }

    let headingContent = (
        <View style={styles.heading}>
            <View style={styles.icon}>
                <Ionicons name={icon} size={24} color={theme.colors.primary} />
            </View>
            <View style={styles.copy}>
                <AppText accessibilityRole="header" aria-level={2} variant="section" style={styles.cardHeadingTitle}>
                    {title}
                </AppText>
                <AppText variant="muted" style={styles.description}>{description}</AppText>
            </View>
        </View>
    );
    if (useCompactOpenLayout && !statusFailed) {
        headingContent = (
            <View style={styles.copy}>
                <AppText accessibilityRole="header" aria-level={2} variant="section" style={styles.cardHeadingTitle}>
                    {title}
                </AppText>
                <AppText variant="muted" style={styles.description}>{description}</AppText>
            </View>
        );
    } else if (useExpandedPauseLayout) {
        headingContent = (
            <View style={styles.expandedContent}>
                <View style={styles.expandedIcon}>
                    <Ionicons
                        name={icon}
                        size={EXPANDED_STATUS_GLYPH_SIZE}
                        color={theme.colors.primary}
                    />
                </View>
                <View style={styles.expandedCopy}>
                    <AppText variant="label" style={styles.expandedStatusLabel}>
                        Today's status
                    </AppText>
                    <AppText
                        accessibilityRole="header"
                        aria-level={2}
                        variant="title"
                        style={styles.expandedTitle}
                    >
                        {title}
                    </AppText>
                    <AppText variant="body" style={styles.expandedDescription}>
                        {description}
                    </AppText>
                </View>
            </View>
        );
    }

    return (
        <>
            {presentation === 'section' ? <AppSection
                density={useCompactOpenLayout ? 'compact' : 'comfortable'}
                accessibilityLabel={`${title}. ${description}`}
                style={[
                    styles.section,
                    useExpandedPauseLayout && styles.cardExpanded,
                    style
                ]}
            >
                {headingContent}

                {day.status === 'OPEN' && (
                    <View style={[styles.actions, useCompactOpenLayout && styles.actionsCompact, fontScale >= 1.3 && styles.actionsStacked]}>
                        <AppButton
                            title="Complete day"
                            variant="primary"
                            accessibilityLabel="Complete day"
                            disabled={isBusy}
                            onPress={() => setStatus.mutate('COMPLETE')}
                            style={[
                                styles.action,
                                useCompactOpenLayout && styles.actionCompact,
                                fontScale >= 1.3 && styles.actionStacked
                            ]}
                            leftIcon={<Ionicons
                                name="checkmark-circle-outline"
                                size={18}
                                color={theme.colors.onPrimary}
                            />}
                        />
                        {isToday && (
                            <AppButton
                                title="Pause tracking"
                                variant="secondary"
                                disabled={isBusy}
                                onPress={() => setPauseSheetOpen(true)}
                                style={[styles.action, styles.pauseAction, useCompactOpenLayout && styles.actionCompact, fontScale >= 1.3 && styles.actionStacked]}
                                textStyle={styles.pauseText}
                                leftIcon={<Ionicons
                                    name="pause-circle-outline"
                                    size={18}
                                    color={theme.colors.primary}
                                />}
                            />
                        )}
                    </View>
                )}
                {(day.status === 'COMPLETE' || day.status === 'INCOMPLETE' || (day.status === 'PAUSED' && !isToday)) && (
                    <AppButton
                        title={day.status === 'COMPLETE' && !statusFailed ? 'Edit or backfill' : 'Backfill this day'}
                        variant="secondary"
                        disabled={isBusy}
                        onPress={() => setStatus.mutate('OPEN')}
                    />
                )}
                {day.status === 'PAUSED' && isToday && (
                    <AppButton
                        title={resume.isPending ? 'Resuming...' : 'Resume tracking'}
                        disabled={isBusy}
                        onPress={() => resume.mutate()}
                        style={useExpandedPauseLayout && styles.expandedAction}
                        leftIcon={useExpandedPauseLayout
                            ? <Ionicons
                                name="play-circle-outline"
                                size={20}
                                color={theme.colors.onPrimary}
                            />
                            : undefined}
                    />
                )}
                {actionError && (
                    <AppText accessibilityRole="alert" style={styles.error}>
                        {getSafeActionErrorMessage(actionError, 'Unable to update food tracking.')}
                    </AppText>
                )}
            </AppSection> : <View testID={presentation === 'dock' ? 'today-action-dock' : 'today-day-controls'} style={[styles.dock, style]}>
                {presentation === 'dock' && <View style={[styles.dockActions, stackDockActions && styles.actionsStacked]}>
                    {day.status === 'OPEN' && <FoodLogDockActions
                        stacked={stackDockActions}
                        addFood={<AppButton title="Add food" onPress={onAddFood} disabled={!onAddFood || isBusy} style={dockActionStyle} textStyle={dockLabelStyle} />}
                        dayAction={<AppButton title="Complete day" variant="secondary" onPress={() => setStatus.mutate('COMPLETE')} disabled={isBusy || statusFailed} style={[dockActionStyle, styles.dockSecondary]} textStyle={[dockLabelStyle, styles.pauseText]} />}
                    />}
                    {day.status === 'COMPLETE' && <FoodLogDockActions
                        stacked={stackDockActions}
                        addFood={<AppButton title="Add food" disabled style={dockActionStyle} textStyle={dockLabelStyle} />}
                        dayAction={<AppButton
                            title={confirmedComplete ? 'Day completed' : 'Reopen day'}
                            variant={confirmedComplete ? 'primary' : 'secondary'}
                            aria-pressed={confirmedComplete}
                            accessibilityState={{ selected: confirmedComplete }}
                            accessibilityHint="Reopens this day so you can add or edit food"
                            disabled={isBusy}
                            onPress={() => setStatus.mutate('OPEN')}
                            style={[dockActionStyle, confirmedComplete && styles.completedAction]}
                            textStyle={[dockLabelStyle, confirmedComplete && { color: completedForeground }]}
                            leftIcon={confirmedComplete ? <Ionicons name="checkmark" size={18} color={completedForeground} /> : undefined}
                        />}
                    />}
                    {(day.status === 'INCOMPLETE' || (day.status === 'PAUSED' && !isToday)) && <AppButton title="Edit day" variant="secondary" disabled={isBusy} onPress={() => setStatus.mutate('OPEN')} style={[dockActionStyle, styles.dockSecondary]} textStyle={[styles.dockLabel, styles.pauseText]} />}
                    {day.status === 'PAUSED' && isToday && <AppButton title={resume.isPending ? 'Resuming...' : 'Resume tracking'} disabled={isBusy} onPress={() => resume.mutate()} style={dockActionStyle} textStyle={styles.dockLabel} />}
                </View>}
                {presentation === 'dock' && statusFailed && <AppText variant="muted">Day status unavailable</AppText>}
                {presentation === 'controls' && isToday && day.status === 'OPEN' && <AppButton title="Pause tracking" variant="secondary" disabled={isBusy} onPress={() => setPauseSheetOpen(true)} leftIcon={<Ionicons name="pause-circle-outline" size={20} color={theme.colors.primary} />} />}
                {actionError && <AppText accessibilityRole="alert" style={styles.error}>{getSafeActionErrorMessage(actionError, 'Unable to update food tracking.')}</AppText>}
            </View>}

            <BottomSheetModal
                visible={pauseSheetOpen}
                onRequestClose={() => setPauseSheetOpen(false)}
            >
                <SectionHeader
                    title="Pause calorie tracking?"
                    description="Calorie tracking and all reminders will stop. Your goal remains active, and you can still enter weight whenever you want."
                />
                <AppButton
                    title={startPause.isPending ? 'Pausing...' : 'Until I resume'}
                    disabled={startPause.isPending}
                    onPress={() => startPause.mutate(null)}
                />
                {!showExpectedDate && (
                    <AppButton
                        title="Choose expected resume date"
                        variant="secondary"
                        onPress={() => setShowExpectedDate(true)}
                    />
                )}
                {showExpectedDate && (
                    <>
                        <DatePickerField
                            label="Expected resume date"
                            value={expectedResumeOn}
                            minimumDate={addDaysToDateOnly(date, 1)}
                            fallbackDate={addDaysToDateOnly(date, 1)}
                            onChangeDate={setExpectedResumeOn}
                            helperText="This date will show a confirmation in the app. It will not resume tracking automatically."
                        />
                        <AppButton
                            title="Pause with this date"
                            disabled={!expectedResumeOn || startPause.isPending}
                            onPress={() => startPause.mutate(expectedResumeOn)}
                        />
                    </>
                )}
                <AppButton title="Cancel" variant="ghost" onPress={() => setPauseSheetOpen(false)} />
            </BottomSheetModal>
        </>
    );
};

export const ResumeTrackingPrompt: React.FC = () => {
    const { api, user } = useAuth();
    const { enqueue, withOutbox, mutations = [] } = useOfflineOutbox();
    const queryClient = useQueryClient();
    const theme = useAppTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    const today = useCurrentLocalDate(user?.timezone);
    const pauseQuery = useFoodTrackingPause();
    const { refetch: refetchPause } = pauseQuery;
    const [dismissedThisForeground, setDismissedThisForeground] = useState(false);
    const [showExtend, setShowExtend] = useState(false);
    const [customDate, setCustomDate] = useState('');

    useEffect(() => {
        const subscription = AppState.addEventListener('change', (state) => {
            if (state !== 'active') return;
            setDismissedThisForeground(false);
            void refetchPause();
        });
        return () => subscription.remove();
    }, [refetchPause]);

    const refresh = useRefreshTrackingState(today);
    const resume = useMutation({
        networkMode: 'always', // Persist local intent even when React Query knows the network is offline.
        mutationFn: () => {
            const payload = { resumed_on: today };
            return executeOrQueueMutation({
                withOutbox,
                forceQueue: mutations.length > 0,
                operation: OFFLINE_MUTATION_OPERATIONS.RESUME_FOOD_TRACKING,
                payload,
                execute: (operationId) => api.resumeFoodTracking(payload, operationId),
                enqueue
            });
        },
        onSuccess: async () => {
            queryClient.setQueryData(foodDayQueryKey(today), storedDay(today, 'OPEN'));
            setDismissedThisForeground(true);
            setShowExtend(false);
            await refresh();
        }
    });
    const extend = useMutation({
        networkMode: 'always', // Persist local intent even when React Query knows the network is offline.
        mutationFn: (expectedResumeOn: string | null) => {
            const payload = { expected_resume_on: expectedResumeOn };
            return executeOrQueueMutation({
                withOutbox,
                forceQueue: mutations.length > 0,
                operation: OFFLINE_MUTATION_OPERATIONS.UPDATE_FOOD_TRACKING_PAUSE,
                payload,
                execute: (operationId) => api.updateFoodTrackingPause(payload, operationId),
                enqueue
            });
        },
        onSuccess: async (result, expectedResumeOn) => {
            const current = pauseQuery.data?.pause ?? activePause(today, expectedResumeOn);
            const pause = result.disposition === 'synced'
                ? result.value.pause
                : { ...current, expected_resume_on: expectedResumeOn, resume_confirmation_due: false };
            queryClient.setQueryData(foodTrackingPauseQueryKey, { pause });
            setDismissedThisForeground(true);
            setShowExtend(false);
            setCustomDate('');
            await refresh();
        }
    });

    const pause = pauseQuery.data?.pause;
    const visible = Boolean(
        pause?.active &&
        pause.resume_confirmation_due &&
        !dismissedThisForeground
    );
    const error = pauseQuery.error ?? resume.error ?? extend.error;

    return (
        <BottomSheetModal
            visible={visible}
            accessibilityLabel="Ready to resume tracking?"
            onRequestClose={() => setDismissedThisForeground(true)}
        >
            {!showExtend ? (
                <>
                    <SectionHeader
                        title="Ready to resume tracking?"
                        description="Tracking stays paused until you confirm."
                    />
                    <AppButton
                        title={resume.isPending ? 'Resuming...' : 'Resume tracking'}
                        disabled={resume.isPending || extend.isPending}
                        onPress={() => resume.mutate()}
                    />
                    <AppButton
                        title="Extend pause"
                        variant="secondary"
                        disabled={resume.isPending || extend.isPending}
                        onPress={() => setShowExtend(true)}
                    />
                </>
            ) : (
                <>
                    <SectionHeader title="Extend pause" description="When should Calibrate ask again?" />
                    <AppButton
                        title="Tomorrow"
                        disabled={extend.isPending}
                        onPress={() => extend.mutate(addDaysToDateOnly(today, 1))}
                    />
                    <DatePickerField
                        label="Choose another date"
                        value={customDate}
                        minimumDate={addDaysToDateOnly(today, 1)}
                        fallbackDate={addDaysToDateOnly(today, 1)}
                        onChangeDate={setCustomDate}
                    />
                    <AppButton
                        title="Use chosen date"
                        variant="secondary"
                        disabled={!customDate || extend.isPending}
                        onPress={() => extend.mutate(customDate)}
                    />
                    <AppButton
                        title="Until I resume"
                        variant="secondary"
                        disabled={extend.isPending}
                        onPress={() => extend.mutate(null)}
                    />
                    <AppButton title="Back" variant="ghost" onPress={() => setShowExtend(false)} />
                </>
            )}
            {error && (
                <AppText accessibilityRole="alert" style={styles.error}>
                    {getSafeActionErrorMessage(error, 'Unable to update the tracking pause.')}
                </AppText>
            )}
        </BottomSheetModal>
    );
};

function createStyles(theme: AppTheme) {
    return StyleSheet.create({
        section: {
            borderTopColor: theme.colors.outlineVariant,
            borderTopWidth: StyleSheet.hairlineWidth,
            paddingTop: theme.spacing.lg
        },
        cardExpanded: {
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: theme.spacing.xxl,
            paddingVertical: theme.spacing.xxl,
            gap: theme.spacing.xl,
            backgroundColor: theme.colors.surfaceContainer,
            borderLeftColor: theme.colors.primary,
            borderLeftWidth: theme.interaction.focusRingWidth
        },
        expandedContent: {
            width: '100%',
            maxWidth: EXPANDED_STATUS_CONTENT_MAX_WIDTH,
            alignItems: 'center',
            gap: theme.spacing.lg
        },
        expandedIcon: {
            width: EXPANDED_STATUS_ICON_SIZE,
            height: EXPANDED_STATUS_ICON_SIZE,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: theme.radius.pill,
            backgroundColor: theme.colors.primaryContainer
        },
        expandedCopy: {
            width: '100%',
            alignItems: 'center',
            gap: theme.spacing.sm
        },
        expandedStatusLabel: {
            color: theme.colors.primary,
            fontWeight: '600',
            textTransform: 'uppercase'
        },
        expandedTitle: {
            textAlign: 'center'
        },
        expandedDescription: {
            color: theme.colors.onSurfaceVariant,
            textAlign: 'center'
        },
        expandedAction: {
            width: '100%',
            maxWidth: EXPANDED_STATUS_ACTION_MAX_WIDTH,
            paddingVertical: theme.spacing.md
        },
        heading: {
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: theme.spacing.md
        },
        icon: {
            width: 24,
            height: 24,
            alignItems: 'center',
            justifyContent: 'center',
        },
        copy: {
            flex: 1,
            minWidth: 0,
            gap: theme.spacing.xs
        },
        cardHeadingTitle: {
            color: theme.colors.onSurface,
            fontWeight: '600'
        },
        description: { ...theme.typography.styles.label, fontWeight: '400' },
        actions: {
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: theme.spacing.sm
        },
        dock: { paddingVertical: theme.spacing.md, gap: theme.spacing.sm },
        dockActions: { flexDirection: 'row', gap: theme.spacing.sm, alignItems: 'stretch' },
        // Keep keyboard focus visible inside the animated dock clipping boundary.
        dockAction: { flex: 1, minWidth: 0, minHeight: 52, paddingHorizontal: theme.spacing.sm, outlineOffset: -theme.interaction.focusRingWidth },
        dockActionNarrow: { paddingHorizontal: theme.spacing.xs },
        dockActionStacked: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto', width: '100%' },
        dockLabel: { ...theme.typography.styles.body, fontWeight: '600' },
        dockNarrowLabel: theme.typography.styles.label,
        dockSecondary: { borderColor: theme.colors.primary },
        completedAction: { backgroundColor: theme.mode === 'dark' ? theme.colors.primaryContainer : theme.colors.primary },
        actionsCompact: {
            flexWrap: 'nowrap'
        },
        actionsStacked: { flexDirection: 'column' },
        action: {
            flexGrow: 1
        },
        actionCompact: {
            flexGrow: 1,
            flexShrink: 1,
            minWidth: 0,
            paddingHorizontal: theme.spacing.xs,
            width: 0
        },
        actionStacked: { width: '100%', flexGrow: 0, flexShrink: 0 },
        pauseAction: { borderColor: theme.colors.primary, backgroundColor: theme.colors.summaryContainer },
        pauseText: { color: theme.colors.primary },
        error: {
            color: theme.colors.danger
        }
    });
}
