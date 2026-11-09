/** @file Pure responsive tracking-window and weekly-report presentation shared by the app and synthetic previews. */
import { useState } from 'react';
import { StyleSheet, View, type ViewProps } from 'react-native';
import type { PlanCheckResponse, PlanCheckWindow, WeeklyProgressReport } from '@calibrate/api-client';
import { AppButton } from './AppButton';
import { AppSection } from './AppSection';
import { AppText } from './AppText';
import { AppNotice } from './AppNotice';
import { CardHeader } from './CardHeader';
import { SkeletonBlock } from './SkeletonBlock';
import { formatDateOnlyForDisplay } from '../utils/dates';
import { spacing, typeScale } from '../theme';

const POUNDS_PER_KILOGRAM = 2.2046226218;
type PlanCheckCardViewProps = ViewProps & {
    hideTitle?: boolean;
    status?: PlanCheckResponse;
    isLoading?: boolean;
    onLogWeight?: () => void;
};

function weightChange(value: number, unit: 'KG' | 'LB'): string {
    const converted = unit === 'LB' ? value * POUNDS_PER_KILOGRAM : value;
    if (Math.abs(converted) < 0.005) return 'About steady';
    const label = unit === 'LB' ? 'lb' : 'kg';
    return `${Math.abs(converted).toFixed(2)} ${label} ${converted < 0 ? 'loss' : 'gain'}`;
}

function TrendWindow({ window, unit, needsWeighIn }: { window: PlanCheckWindow; unit: 'KG' | 'LB'; needsWeighIn: boolean }) {
    const rate = window.weeklyWeightChangeKg;
    return <AppSection density="compact" testID={`plan-check-window-${window.days}`}>
        <AppText variant="section" accessibilityRole="header">Last {window.days} days</AppText>
        <AppText variant="muted">{formatDateOnlyForDisplay(window.startDate)} - {formatDateOnlyForDisplay(window.endDate)}</AppText>
        {!needsWeighIn && rate !== null && <View style={styles.group}>
            <AppText style={styles.measurement}>{weightChange(rate, unit)} / week</AppText>
            <AppText variant="muted">{window.weighIns} weigh-ins across {window.weightSpanDays} days</AppText>
            {window.weightChangeKg !== null && <AppText variant="muted">First to latest reading: {weightChange(window.weightChangeKg, unit)}</AppText>}
        </View>}
        {!needsWeighIn && rate === null && <AppText variant="muted">More weigh-ins spread across this period are needed for a weight trend.</AppText>}
        <View style={styles.group}>
            <AppText>{window.averageLoggedCalories === null ? 'No food logged in this period' : `${window.averageLoggedCalories.toLocaleString()} kcal / logged day`}</AppText>
            <AppText variant="muted">Food logged on {window.loggedFoodDays} of {window.days} days | {window.completeFoodDays} marked complete</AppText>
        </View>
    </AppSection>;
}

function WeeklyReports({ reports, enabled }: { reports: WeeklyProgressReport[]; enabled: boolean }) {
    const [selectedDate, setSelectedDate] = useState<string | null>(null);
    const [showHistory, setShowHistory] = useState(false);
    if (!enabled && reports.length === 0) return null;
    const report = reports.find(item => item.reportDate === selectedDate) ?? reports[0];
    return <AppSection density="compact" testID="weekly-progress-report">
        <AppText variant="section" accessibilityRole="header">Weekly report</AppText>
        {!report && <AppText variant="muted">Your first weekly report will be available on a Sunday after at least a week of tracking.</AppText>}
        {report && <>
            <AppText variant="muted">Sunday, {formatDateOnlyForDisplay(report.reportDate)} | AI-generated</AppText>
            <AppText>{report.summary}</AppText>
            {report.highlights.map((highlight, index) => <AppText key={index}>- {highlight}</AppText>)}
            <AppText style={styles.nextStep}>{report.nextStep}</AppText>
            <AppText variant="caption">Based on your saved tracking data. AI analysis can make mistakes.</AppText>
        </>}
        {reports.length > 1 && <AppButton title={showHistory ? 'Hide report history' : 'Report history'} variant="secondary" onPress={() => setShowHistory(!showHistory)} />}
        {showHistory && reports.map(item => <AppButton
            key={item.reportDate} title={formatDateOnlyForDisplay(item.reportDate)} variant="secondary"
            onPress={() => { setSelectedDate(item.reportDate); setShowHistory(false); }}
        />)}
    </AppSection>;
}

/** Render available durations independently of calorie-plan eligibility and food-log consistency. */
export function PlanCheckCardView({ status, hideTitle, isLoading, onLogWeight, style, ...props }: PlanCheckCardViewProps) {
    return <View testID="plan-check-section" {...props} style={[styles.root, style]}>
        {!hideTitle && <CardHeader title="Plan check" density="compact" />}
        {(isLoading || !status) && <View accessibilityLabel="Loading plan check" style={styles.group}>
            <SkeletonBlock height={24} width="45%" /><SkeletonBlock height={72} />
        </View>}
        {status && <>
            {status.windows.length === 0 && <AppText variant="muted">Your first trend summary appears after 7 days of tracking.</AppText>}
            {status.needsWeighIn && status.windows.length > 0 && <AppNotice>
                <AppText>Log your weight today to restore weight trends. A weigh-in from today or yesterday is needed.</AppText>
                {onLogWeight && <AppButton title="Log weight" onPress={onLogWeight} />}
            </AppNotice>}
            {status.windows.map(window => <TrendWindow key={window.days} window={window} unit={status.weightUnit} needsWeighIn={status.needsWeighIn} />)}
            {status.windows.length > 0 && <AppText variant="caption">
                Food averages include partial logs and exclude days without entries unless marked complete. Weight rates summarize recorded weigh-ins, including today when available; they are not forecasts.
            </AppText>}
            <WeeklyReports reports={status.weeklyReports} enabled={status.weeklyReportsEnabled} />
        </>}
    </View>;
}

const styles = StyleSheet.create({
    root: { gap: spacing.xl },
    group: { gap: spacing.xs },
    measurement: { ...typeScale.section, fontVariant: ['tabular-nums'] },
    nextStep: { fontWeight: '600' }
});
