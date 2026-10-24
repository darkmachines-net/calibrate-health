import React, { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery } from '@tanstack/react-query';
import { useOfflineOutbox } from '../offline/provider';
import { createOutboxNamespace } from '../offline/queuedMutation';
import { calendarDayWithIntent } from './calendarIntent';
import { useAuth } from '../auth/AuthContext';
import {
    foodDayRangeQueryKey,
    getCalendarMonthRange,
    getCalendarWeeks,
    getFoodDayCalendarMarker,
    getFoodDayCalendarLabel,
    getFoodDayCalorieBand,
    getMonthKey,
    shiftMonth,
    type FoodDayCalendarMarker
} from './calendar';
import { formatDateOnlyForDisplay } from '../utils/dates';
import { type AppTheme, useAppTheme } from '../theme';
import { AppText } from '../components/AppText';
import { AsyncStateBoundary, useAsyncResourceState, useOnlineStatus } from '../components/AsyncStateBoundary';
import { CalendarModal } from '../components/CalendarModal';
import { isNeverEmpty } from '../asyncState/resolveAsyncState';
import { useFoodTrackingPause } from './useFoodTrackingPause';
import { getActivePausePlan, getPauseBrowseMonth, isPlannedPauseDate } from './plannedPause';

type HistoricalDatePickerProps = {
    visible: boolean;
    selectedDate: string;
    minDate: string;
    maxDate: string;
    onSelectDate: (date: string) => void;
    onRequestClose: () => void;
    footer?: React.ReactNode;
};

const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const;
const CALENDAR_DAY_HEIGHT = 48; // Keeps each compact calendar row physically tappable.
const CALENDAR_STATUS_BADGE_SIZE = 34; // Makes the historical state the primary calendar-day silhouette.
const CALENDAR_LEGEND_MARKER_SIZE = 10; // Keeps legend symbols proportional to their compact labels.
const CALENDAR_CONTENT_MAX_WIDTH = 560; // Prevents calendar cells from stretching across wide browser sheets.
const CALENDAR_STATE_ICON_SIZE = 8; // Fits the pause or not-started glyph beneath a date inside its badge.
const CALENDAR_STATE_ICON_GAP = 2; // Separates each state glyph from its date without enlarging the normal badge.
const CALENDAR_LEGEND_STATE_SIZE = 14; // Makes neutral tracking shapes large enough to distinguish their glyphs.

function formatMonth(monthKey: string): string {
    const [yearString, monthString] = monthKey.split('-');
    return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(
        new Date(Number(yearString), Number(monthString) - 1, 1)
    );
}

const COMPLETED_MARKERS = {
    'complete-target': { label: 'Met target' },
    'complete-between': { label: 'Near target' },
    'complete-beyond': { label: 'Off target' },
    'complete-unavailable': { label: 'Completed' }
} as const;

function completedMarker(marker: FoodDayCalendarMarker) {
    if (marker in COMPLETED_MARKERS) return COMPLETED_MARKERS[marker as keyof typeof COMPLETED_MARKERS];
    return null;
}

function completedColors(marker: FoodDayCalendarMarker, theme: AppTheme) {
    switch (marker) {
        case 'complete-target':
        case 'complete-unavailable': return { backgroundColor: theme.colors.success, color: theme.colors.onSuccess };
        case 'complete-between': return { backgroundColor: theme.colors.calendarBetween, color: theme.colors.onCalendarBetween };
        case 'complete-beyond': return { backgroundColor: theme.colors.calendarBeyond, color: theme.colors.onCalendarBeyond };
        default: return { backgroundColor: theme.colors.surfaceContainerHigh, color: theme.colors.onSurfaceVariant };
    }
}

const CalendarMarker: React.FC<{
    marker: FoodDayCalendarMarker;
    theme: AppTheme;
    styles: ReturnType<typeof createStyles>;
}> = ({ marker, theme, styles }) => {
    if (marker === 'paused') {
        return <View testID="calendar-marker-paused" style={styles.pausedMarker}>
            <Ionicons name="pause" size={CALENDAR_STATE_ICON_SIZE} allowFontScaling={false} style={styles.stateGlyph} color={theme.colors.onSurfaceVariant} />
        </View>;
    }
    const complete = completedMarker(marker);
    if (complete) {
        const colors = completedColors(marker, theme);
        return <View style={[styles.completeMarker, { backgroundColor: colors.backgroundColor }]} />;
    }
    if (marker === 'incomplete') return <View testID="calendar-marker-incomplete" style={styles.incompleteMarker} />;
    if (marker === 'not-started') return <View testID="calendar-marker-not-started" style={styles.notStartedMarker}>
        <Ionicons name="close" size={CALENDAR_STATE_ICON_SIZE} allowFontScaling={false} style={styles.stateGlyph} color={theme.colors.onSurfaceVariant} />
    </View>;
    return <View style={styles.markerPlaceholder} />;
};

const LegendItem: React.FC<{
    label: string;
    marker: FoodDayCalendarMarker;
    theme: AppTheme;
    styles: ReturnType<typeof createStyles>;
    style?: StyleProp<ViewStyle>;
}> = ({ label, marker, theme, styles, style }) => (
    <View style={[styles.legendItem, style]}>
        <View style={styles.legendMarker}>
            <CalendarMarker marker={marker} theme={theme} styles={styles} />
        </View>
        <AppText variant="caption" style={styles.legendLabel}>{label}</AppText>
    </View>
);

export const HistoricalDatePicker: React.FC<HistoricalDatePickerProps> = ({
    visible,
    selectedDate,
    minDate,
    maxDate,
    onSelectDate,
    onRequestClose,
    footer
}) => {
    const { api, user, serverUrl } = useAuth();
    const { dayIntents = [], mutations = [], readFoodDays } = useOfflineOutbox();
    const namespace = user && serverUrl ? createOutboxNamespace(serverUrl, user.id) : null;
    const dayIntent = [...dayIntents, ...mutations].filter(row => row.namespace === namespace && row.state !== 'failed');
    const theme = useAppTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    const [visibleMonth, setVisibleMonth] = useState(() => getMonthKey(selectedDate));
    const [keyExpanded, setKeyExpanded] = useState(false);
    const [colorGuideExpanded, setColorGuideExpanded] = useState(false);
    const pauseQuery = useFoodTrackingPause(visible);
    const { refetch: refetchPause } = pauseQuery;
    const pausePlan = getActivePausePlan(pauseQuery.data?.pause, maxDate);
    const lastBrowseMonth = getPauseBrowseMonth(maxDate, pausePlan);

    useEffect(() => {
        setVisibleMonth(month => month > lastBrowseMonth ? lastBrowseMonth : month);
    }, [lastBrowseMonth]);

    useLayoutEffect(() => {
        if (visible) {
            setVisibleMonth(getMonthKey(selectedDate));
            setKeyExpanded(false);
            setColorGuideExpanded(false);
        }
    }, [selectedDate, visible]);

    const displayMonth = visibleMonth > lastBrowseMonth ? lastBrowseMonth : visibleMonth;
    useEffect(() => {
        if (visible) void refetchPause();
    }, [visible, displayMonth, refetchPause]);
    const monthRange = getCalendarMonthRange(displayMonth, minDate, maxDate);
    const hasHistory = monthRange.startDate <= monthRange.endDate;
    const rangeQuery = useQuery({
        queryKey: foodDayRangeQueryKey(monthRange.startDate, monthRange.endDate),
        queryFn: () => {
            const fetch = () => api.getFoodDays(monthRange.startDate, monthRange.endDate);
            return readFoodDays ? readFoodDays(fetch) : fetch();
        },
        enabled: visible && hasHistory
    });
    const isOnline = useOnlineStatus();
    const rangeState = useAsyncResourceState(rangeQuery, isNeverEmpty);
    const dayByDate = useMemo(
        () => new Map((rangeQuery.data?.days ?? []).map((day) => [day.date, day])),
        [rangeQuery.data?.days]
    );
    const weeks = useMemo(() => getCalendarWeeks(displayMonth), [displayMonth]);
    const hasLocalHistory = weeks.flat().some(date => date && date >= minDate && date <= maxDate
        && calendarDayWithIntent(date, undefined, dayIntent) !== undefined);
    const localHistoryOnly = !rangeQuery.data && hasLocalHistory;
    const visibleRangeState = localHistoryOnly && rangeState.kind === 'error'
        ? { ...rangeState, kind: 'degraded' as const }
        : localHistoryOnly ? { kind: 'content' as const, error: null } : rangeState;
    const canGoPrevious = displayMonth > getMonthKey(minDate);
    const canGoNext = displayMonth < lastBrowseMonth;
    let planNotice: string | null = null;
    if (!isOnline) planNotice = pausePlan ? 'Offline - showing saved pause plan.' : 'Pause plan unavailable offline.';
    else if (pauseQuery.isError) planNotice = pausePlan ? 'Could not refresh the saved pause plan.' : 'Pause plan unavailable.';
    else if (pauseQuery.isPending) planNotice = 'Loading pause plan...';
    else if (pauseQuery.data?.pause.active && !pausePlan) planNotice = 'Pause plan unavailable.';

    function selectDate(date: string) {
        if (date < minDate || date > maxDate) return;
        onSelectDate(date);
        onRequestClose();
    }

    return (
        <CalendarModal visible={visible} onRequestClose={onRequestClose}>
            <View style={styles.calendarContent}>
                <View style={styles.heading}>
                    <View style={styles.headingCopy}>
                        <AppText variant="subtitle">Choose a day</AppText>
                    </View>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Close date picker"
                        onPress={onRequestClose}
                        style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
                    >
                        <Ionicons name="close" size={22} color={theme.colors.onSurface} />
                    </Pressable>
                </View>

                <View style={styles.monthNavigation}>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Previous month"
                        accessibilityState={{ disabled: !canGoPrevious }}
                        disabled={!canGoPrevious}
                        onPress={() => setVisibleMonth((month) => shiftMonth(month, -1))}
                        style={({ pressed }) => [
                            styles.iconButton,
                            !canGoPrevious && styles.disabled,
                            pressed && styles.pressed
                        ]}
                    >
                        <Ionicons name="chevron-back" size={22} color={theme.colors.onSurface} />
                    </Pressable>
                    <AppText variant="subtitle" style={styles.monthLabel}>{formatMonth(displayMonth)}</AppText>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Next month"
                        accessibilityState={{ disabled: !canGoNext }}
                        disabled={!canGoNext}
                        onPress={() => setVisibleMonth((month) => shiftMonth(month, 1))}
                        style={({ pressed }) => [
                            styles.iconButton,
                            !canGoNext && styles.disabled,
                            pressed && styles.pressed
                        ]}
                    >
                        <Ionicons name="chevron-forward" size={22} color={theme.colors.onSurface} />
                    </Pressable>
                </View>

                {localHistoryOnly && <AppText variant="caption">Showing saved tracking changes. Other history is unavailable.</AppText>}
                {planNotice && <AppText variant="caption" accessibilityLiveRegion="polite">{planNotice}</AppText>}
                <AsyncStateBoundary
                    state={hasHistory ? visibleRangeState : { kind: 'content', error: null }}
                    resourceLabel="tracking history"
                    loading={(
                        <View style={styles.queryLoading}>
                            <ActivityIndicator color={theme.colors.primary} size="small" />
                            <AppText variant="caption">Loading history...</AppText>
                        </View>
                    )}
                    empty={null}
                    onRetry={isOnline ? () => rangeQuery.refetch() : undefined}
                    retrying={rangeQuery.isFetching}
                >
                    <>
                        <View>
                            <View style={styles.week}>
                        {WEEKDAY_LABELS.map((label, index) => (
                            <View key={`${label}-${index}`} style={styles.weekday}>
                                <AppText variant="caption" style={styles.weekdayLabel}>{label}</AppText>
                            </View>
                        ))}
                    </View>
                    {weeks.map((week, weekIndex) => (
                        <View key={weekIndex} style={styles.week}>
                            {week.map((date, dayIndex) => {
                                if (!date) return <View key={`empty-${dayIndex}`} style={styles.dayCell} />;
                                const disabled = date < minDate || date > maxDate;
                                const day = date <= maxDate ? calendarDayWithIntent(date, dayByDate.get(date), dayIntent) : undefined;
                                const planned = isPlannedPauseDate(date, maxDate, pausePlan);
                                const marker = getFoodDayCalendarMarker(day, maxDate);
                                const isSelected = date === selectedDate;
                                const isToday = date === maxDate;
                                let statusLabel = localHistoryOnly && !day ? 'tracking status unavailable' : getFoodDayCalendarLabel(day, maxDate);
                                if (date > maxDate) statusLabel = planned ? 'planned tracking pause' : 'future date';
                                if (planned && pausePlan?.expectedResumeOn === null) statusLabel += ', until resumed';
                                const complete = completedMarker(marker);
                                const colors = completedColors(`complete-${getFoodDayCalorieBand(day)}`, theme);
                                const hasStateGlyph = marker === 'paused' || marker === 'not-started' || planned;
                                const stateGlyph = marker === 'not-started' ? 'close' : 'pause';
                                const stateGlyphTestId = marker === 'not-started' ? `calendar-not-started-glyph-${date}` : `calendar-pause-glyph-${date}`;
                                const accessibilityLabel = [
                                    formatDateOnlyForDisplay(date),
                                    isToday ? 'today' : null,
                                    statusLabel,
                                    isSelected ? 'selected' : null
                                ].filter(Boolean).join(', ');
                                return (
                                    <Pressable
                                        key={date}
                                        testID={`calendar-day-${date}`}
                                        accessibilityRole="button"
                                        accessibilityLabel={accessibilityLabel}
                                        accessibilityState={{ disabled, selected: isSelected }}
                                        disabled={disabled}
                                        onPress={() => selectDate(date)}
                                        style={({ pressed }) => [
                                            styles.dayCell,
                                            isSelected && styles.selectedDay,
                                            disabled && !planned && styles.disabled,
                                            pressed && styles.pressed
                                        ]}
                                    >
                                        <View
                                            testID={`calendar-date-badge-${date}`}
                                            style={[
                                                styles.dateBadge,
                                                complete && { backgroundColor: colors.backgroundColor },
                                                marker === 'incomplete' && [styles.incompleteDateBadge, { borderColor: colors.backgroundColor }],
                                                marker === 'not-started' && styles.notStartedDateBadge,
                                                hasStateGlyph && styles.stateBadgeLayout,
                                                marker === 'paused' && styles.pausedDateBadge,
                                                planned && styles.plannedDateBadge
                                            ]}
                                        >
                                            <AppText
                                                variant="label"
                                                style={[
                                                    styles.dayNumber,
                                                    isToday && styles.todayNumber,
                                                    isSelected && marker === 'none' && styles.selectedDayNumber,
                                                    complete && [styles.completeDayNumber, { color: colors.color }],
                                                    marker === 'incomplete' && styles.incompleteDayNumber,
                                                    marker === 'not-started' && styles.notStartedDayNumber,
                                                    hasStateGlyph && styles.glyphDayNumber
                                                ]}
                                            >
                                                {Number(date.slice(-2))}
                                            </AppText>
                                            {hasStateGlyph && (
                                                <View testID={stateGlyphTestId} style={styles.stateGlyphContainer} accessible={false} aria-hidden>
                                                    <Ionicons
                                                        name={stateGlyph}
                                                        size={CALENDAR_STATE_ICON_SIZE}
                                                        allowFontScaling={false}
                                                        style={styles.stateGlyph}
                                                        color={theme.colors.onSurfaceVariant}
                                                    />
                                                </View>
                                            )}
                                        </View>
                                    </Pressable>
                                );
                            })}
                        </View>
                    ))}
                        </View>

                        <View style={styles.key}>
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel="Calendar key"
                                accessibilityState={{ expanded: keyExpanded }}
                                aria-expanded={keyExpanded}
                                onPress={() => setKeyExpanded((expanded) => !expanded)}
                                style={({ pressed }) => [styles.keyToggle, pressed && styles.pressed]}
                            >
                                <View style={styles.keyPreview} accessible={false} aria-hidden>
                                    <CalendarMarker marker="complete-target" theme={theme} styles={styles} />
                                    <CalendarMarker marker="complete-between" theme={theme} styles={styles} />
                                    <CalendarMarker marker="complete-beyond" theme={theme} styles={styles} />
                                </View>
                                <AppText variant="caption" style={styles.keyToggleLabel}>Calendar key</AppText>
                                <Ionicons name={keyExpanded ? 'chevron-up' : 'chevron-down'} size={16} color={theme.colors.onSurfaceVariant} />
                            </Pressable>
                            {keyExpanded && (
                                <View testID="calendar-key-content" style={styles.keyContent}>
                                    <View style={styles.keyHeading}>
                                        <AppText variant="caption" style={styles.keyHeadingLabel}>Calorie balance</AppText>
                                        <Pressable
                                            accessibilityRole="button"
                                            accessibilityLabel="How colors work"
                                            accessibilityState={{ expanded: colorGuideExpanded }}
                                            aria-expanded={colorGuideExpanded}
                                            onPress={() => setColorGuideExpanded((expanded) => !expanded)}
                                            style={({ pressed }) => [styles.colorHelp, pressed && styles.pressed]}
                                        >
                                            <AppText variant="caption">How colors work</AppText>
                                            <Ionicons name={colorGuideExpanded ? 'chevron-up' : 'chevron-down'} size={14} color={theme.colors.onSurfaceVariant} />
                                        </Pressable>
                                    </View>
                                    <View style={styles.completedLegend}>
                                        <LegendItem label={COMPLETED_MARKERS['complete-target'].label} marker="complete-target" theme={theme} styles={styles} style={styles.legendColumn} />
                                        <LegendItem label={COMPLETED_MARKERS['complete-between'].label} marker="complete-between" theme={theme} styles={styles} style={[styles.legendColumn, styles.legendCenter]} />
                                        <LegendItem label={COMPLETED_MARKERS['complete-beyond'].label} marker="complete-beyond" theme={theme} styles={styles} style={[styles.legendColumn, styles.legendEnd]} />
                                    </View>
                                    {colorGuideExpanded && (
                                        <View testID="calendar-color-guide" style={styles.colorGuide}>
                                            <AppText variant="caption">Colors use each day's retained target and maintenance calories. Filled circles are complete; outlines are incomplete.</AppText>
                                            <View style={styles.colorGuideItem}>
                                                <AppText variant="caption" style={styles.keyHeadingLabel}>Met target</AppText>
                                                <AppText variant="caption">At/below target when the target is at/below maintenance. At/above target when the target is above maintenance.</AppText>
                                            </View>
                                            <View style={styles.colorGuideItem}>
                                                <AppText variant="caption" style={styles.keyHeadingLabel}>Near target</AppText>
                                                <AppText variant="caption">Between the saved target and maintenance.</AppText>
                                            </View>
                                            <View style={styles.colorGuideItem}>
                                                <AppText variant="caption" style={styles.keyHeadingLabel}>Off target</AppText>
                                                <AppText variant="caption">Above maintenance when the target is at/below maintenance. Below maintenance when the target is above maintenance.</AppText>
                                            </View>
                                        </View>
                                    )}
                                    <View style={styles.trackingLegend}>
                                        <LegendItem label="Incomplete" marker="incomplete" theme={theme} styles={styles} style={styles.legendColumn} />
                                        <LegendItem label="Not started" marker="not-started" theme={theme} styles={styles} style={[styles.legendColumn, styles.legendCenter]} />
                                        <LegendItem label="Paused" marker="paused" theme={theme} styles={styles} style={[styles.legendColumn, styles.legendEnd]} />
                                    </View>
                                    {pausePlan && <View style={styles.legendItem}>
                                        <View style={styles.plannedLegendMarker}><Ionicons name="pause" size={13} color={theme.colors.onSurfaceVariant} /></View>
                                        <AppText variant="caption" style={styles.legendLabel}>Planned pause{pausePlan.expectedResumeOn === null ? ': until resumed' : ''} (future, view only)</AppText>
                                    </View>}
                                </View>
                            )}
                        </View>
                    </>
                </AsyncStateBoundary>
            </View>
            {footer}
        </CalendarModal>
    );
};

function createStyles(theme: AppTheme) {
    return StyleSheet.create({
        calendarContent: {
            width: '100%',
            maxWidth: CALENDAR_CONTENT_MAX_WIDTH,
            alignSelf: 'center',
            gap: theme.spacing.md
        },
        heading: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: theme.spacing.md
        },
        headingCopy: {
            flex: 1,
            gap: theme.spacing.xs
        },
        monthNavigation: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: theme.spacing.sm
        },
        monthLabel: {
            flex: 1,
            textAlign: 'center'
        },
        iconButton: {
            width: theme.interaction.minimumTouchTarget,
            height: theme.interaction.minimumTouchTarget,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: theme.radius.md
        },
        week: {
            flexDirection: 'row'
        },
        weekday: {
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            paddingBottom: theme.spacing.xs
        },
        weekdayLabel: {
            fontWeight: '700'
        },
        dayCell: {
            flex: 1,
            minHeight: CALENDAR_DAY_HEIGHT,
            paddingVertical: theme.spacing.xs,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: theme.radius.sm,
            borderWidth: theme.stroke.control,
            borderColor: 'transparent'
        },
        selectedDay: {
            backgroundColor: theme.colors.primaryContainer,
            borderColor: theme.colors.primary
        },
        dayNumber: {
            color: theme.colors.onSurface,
            lineHeight: 20
        },
        dateBadge: {
            minWidth: CALENDAR_STATUS_BADGE_SIZE,
            minHeight: CALENDAR_STATUS_BADGE_SIZE,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: CALENDAR_STATUS_BADGE_SIZE / 2
        },
        incompleteDateBadge: {
            borderWidth: 2
        },
        notStartedDateBadge: {
            backgroundColor: theme.colors.surfaceContainer
        },
        pausedDateBadge: {
            borderWidth: theme.stroke.control,
            borderColor: theme.colors.outline,
            backgroundColor: theme.colors.surfaceContainerHigh
        },
        stateBadgeLayout: {
            gap: CALENDAR_STATE_ICON_GAP,
            paddingVertical: theme.spacing.xs
        },
        stateGlyphContainer: {
            width: CALENDAR_STATE_ICON_SIZE,
            height: CALENDAR_STATE_ICON_SIZE,
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0
        },
        stateGlyph: {
            lineHeight: CALENDAR_STATE_ICON_SIZE
        },
        plannedDateBadge: {
            borderWidth: theme.stroke.control,
            borderStyle: 'dashed',
            borderColor: theme.colors.outline,
            backgroundColor: theme.colors.surface
        },
        plannedLegendMarker: {
            borderWidth: theme.stroke.control,
            borderStyle: 'dashed',
            borderColor: theme.colors.outline,
            borderRadius: theme.radius.sm,
            padding: theme.spacing.xs
        },
        todayNumber: {
            color: theme.colors.primary,
            fontWeight: '800'
        },
        selectedDayNumber: {
            color: theme.colors.onPrimaryContainer
        },
        completeDayNumber: {
            fontWeight: '800'
        },
        incompleteDayNumber: {
            color: theme.colors.onSurface,
            fontWeight: '800'
        },
        notStartedDayNumber: {
            color: theme.colors.onSurfaceVariant
        },
        glyphDayNumber: {
            color: theme.colors.onSurfaceVariant,
            fontWeight: '700',
            lineHeight: 14
        },
        markerPlaceholder: {
            width: CALENDAR_LEGEND_MARKER_SIZE,
            height: CALENDAR_LEGEND_MARKER_SIZE
        },
        completeMarker: {
            width: CALENDAR_LEGEND_MARKER_SIZE,
            height: CALENDAR_LEGEND_MARKER_SIZE,
            borderRadius: CALENDAR_LEGEND_MARKER_SIZE / 2
        },
        incompleteMarker: {
            width: CALENDAR_LEGEND_STATE_SIZE,
            height: CALENDAR_LEGEND_STATE_SIZE,
            borderRadius: CALENDAR_LEGEND_STATE_SIZE / 2,
            borderWidth: 2,
            borderColor: theme.colors.onSurfaceVariant
        },
        notStartedMarker: {
            width: CALENDAR_LEGEND_STATE_SIZE,
            height: CALENDAR_LEGEND_STATE_SIZE,
            borderRadius: CALENDAR_LEGEND_STATE_SIZE / 2,
            backgroundColor: theme.colors.surfaceContainer,
            alignItems: 'center',
            justifyContent: 'center'
        },
        pausedMarker: {
            width: CALENDAR_LEGEND_STATE_SIZE,
            height: CALENDAR_LEGEND_STATE_SIZE,
            borderRadius: CALENDAR_LEGEND_STATE_SIZE / 2,
            borderWidth: theme.stroke.control,
            borderColor: theme.colors.onSurfaceVariant,
            alignItems: 'center',
            justifyContent: 'center'
        },
        queryLoading: {
            minHeight: CALENDAR_DAY_HEIGHT * 3,
            alignItems: 'center',
            justifyContent: 'center',
            gap: theme.spacing.sm
        },
        key: {
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: theme.colors.outlineVariant
        },
        keyToggle: {
            minHeight: theme.interaction.minimumTouchTarget,
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.sm
        },
        keyPreview: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.xs
        },
        keyToggleLabel: { flex: 1 },
        keyContent: { gap: theme.spacing.sm },
        keyHeading: {
            flexDirection: 'row',
            alignItems: 'center',
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            columnGap: theme.spacing.sm
        },
        keyHeadingLabel: { fontWeight: '600' },
        colorHelp: {
            minHeight: theme.interaction.minimumTouchTarget,
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.xs
        },
        completedLegend: {
            flexDirection: 'row',
            gap: theme.spacing.xs
        },
        trackingLegend: {
            flexDirection: 'row',
            gap: theme.spacing.xs,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: theme.colors.outlineVariant,
            paddingTop: theme.spacing.sm,
            marginTop: theme.spacing.xs
        },
        legendColumn: {
            flex: 1,
            minWidth: 0
        },
        legendCenter: { justifyContent: 'center' },
        legendEnd: { justifyContent: 'flex-end' },
        colorGuide: {
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: theme.colors.outlineVariant,
            paddingTop: theme.spacing.sm,
            gap: theme.spacing.sm
        },
        colorGuideItem: { gap: theme.spacing.xs },
        legendItem: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.xs,
            flexShrink: 1
        },
        legendLabel: { flexShrink: 1 },
        legendMarker: {
            width: CALENDAR_LEGEND_STATE_SIZE,
            flexShrink: 0,
            alignItems: 'center',
            justifyContent: 'center'
        },
        disabled: {
            opacity: 0.35
        },
        pressed: {
            backgroundColor: theme.colors.surfacePressed
        }
    });
}
