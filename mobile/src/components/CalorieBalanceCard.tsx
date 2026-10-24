/** @file Calorie Balance Card: Empty and populated days share one summary so changing dates does not move the food section below it. */

import React from 'react';
import { StyleSheet, View, useWindowDimensions, type ViewProps } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { AppCard } from './AppCard';
import { AppText } from './AppText';
import { CardHeader } from './CardHeader';
import { spacing, typeScale, useAppTheme, type AppThemeColors } from '../theme';
import { formatNumber } from '../utils/format';

type CalorieBalanceCardProps = ViewProps & {
    totalCalories: number;
    targetCalories: number | null | undefined;
    unavailableLabel?: string;
    supportingLabel?: string;
    comparisonLabel?: string;
    compact?: boolean;
    open?: boolean;
};

const GAUGE_SIZE = 94;
const GAUGE_STROKE = 9;
// The gauge supports the focal calorie number without dominating the overview.
const COMPACT_GAUGE_SIZE = 88;
const COMPACT_GAUGE_STROKE = 9;
// A smaller ring leaves the calorie label readable at the minimum phone width.
const NARROW_GAUGE_SIZE = 80;
const NARROW_PHONE_BREAKPOINT = 360;
// Keep the supported 320px phone layout horizontal; narrower or large-text layouts stack safely.
const HERO_STACK_BREAKPOINT = 320;
// Reflow before accessibility-sized copy competes with the fixed gauge width.
const LARGE_TEXT_STACK_FONT_SCALE = 1.6;
const OPEN_BALANCE_GAP = 20; // Aligns the supporting ring and focal metric in the full-bleed phone summary.

function getBalanceTone(remaining: number | null): 'primary' | 'danger' {
    if (remaining === null) return 'primary';
    if (remaining < 0) return 'danger';
    return 'primary';
}

/**
 * Empty and populated days share one summary so changing dates
 * does not move the food section below it.
 */
export const CalorieBalanceCard: React.FC<CalorieBalanceCardProps> = ({
    totalCalories,
    targetCalories,
    unavailableLabel = 'Target unavailable',
    supportingLabel,
    comparisonLabel,
    compact = false,
    open = false,
    style,
    ...props
}) => {
    const { colors } = useAppTheme();
    const styles = React.useMemo(() => createStyles(colors), [colors]);
    const { width, fontScale } = useWindowDimensions();
    const hasTarget = typeof targetCalories === 'number' && Number.isFinite(targetCalories) && targetCalories > 0;
    const remaining = hasTarget ? Math.round(targetCalories - totalCalories) : null;
    const isOver = remaining !== null && remaining < 0;
    const progressValue = hasTarget ? Math.min(totalCalories / targetCalories, 1) : null;
    const tone = getBalanceTone(remaining);
    const balanceValue = remaining === null ? '-' : formatNumber(Math.abs(remaining), 0);
    const balanceLabel = remaining === null ? unavailableLabel : isOver ? 'kcal over target' : 'kcal remaining';
    const balanceSummary = remaining === null ? balanceLabel : `${balanceValue} ${balanceLabel}`;
    const stackHero = width < HERO_STACK_BREAKPOINT || fontScale >= LARGE_TEXT_STACK_FONT_SCALE;
    // Reserve the focal metric's line so unresolved days do not collapse the summary.
    const useFullMetric = open && width >= NARROW_PHONE_BREAKPOINT;
    const metricHeight = (compact && !useFullMetric ? typeScale.compactMetric.lineHeight : typeScale.metric.lineHeight) * fontScale;

    return (
        <AppCard
            {...props}
            density={compact ? 'compact' : 'comfortable'}
            accessible
            accessibilityLabel={hasTarget
                ? `Daily balance. ${balanceSummary}. ${formatNumber(totalCalories, 0)} eaten out of ${formatNumber(targetCalories, 0)} calorie target.${comparisonLabel ? ` ${comparisonLabel}.` : ''}`
                : `Daily balance. ${balanceSummary}. ${supportingLabel ?? `${formatNumber(totalCalories, 0)} calories logged`}.`}
            style={[styles.surface, open && styles.open, style]}
        >
            <View
                testID="calorie-balance-hero"
                style={[styles.hero, compact && styles.heroCompact, useFullMetric && { gap: OPEN_BALANCE_GAP }, stackHero && styles.heroStacked]}
            >
                <CalorieGauge value={progressValue} tone={tone} compact={compact} narrow={width < NARROW_PHONE_BREAKPOINT} colors={colors} styles={styles} />
                <View style={[
                    styles.balanceCopy,
                    !stackHero && styles.dividedCopy,
                    !stackHero && useFullMetric && { paddingLeft: OPEN_BALANCE_GAP },
                    stackHero && styles.balanceCopyStacked
                ]}>
                    {open ? <AppText accessibilityRole="header" aria-level={2} variant="body" style={styles.openHeading}>Daily balance</AppText> : <CardHeader title="Daily balance" density="compact" />}
                    <View style={[styles.metricSlot, { minHeight: metricHeight }]}>
                        {remaining === null ? (
                            <AppText style={styles.unavailable}>{balanceLabel}</AppText>
                        ) : (
                            <AppText testID="calorie-balance-value" style={[
                                styles.balanceValue,
                                compact && !useFullMetric && styles.balanceValueCompact,
                                styles[`${tone}Text`]
                            ]}>{balanceValue}</AppText>
                        )}
                    </View>
                    <AppText style={[styles.balanceLabel, isOver && styles.dangerText]}>
                        {supportingLabel ?? (remaining === null ? `${formatNumber(totalCalories, 0)} kcal logged` : balanceLabel)}
                    </AppText>
                    {hasTarget && comparisonLabel && <AppText variant="caption" style={styles.comparisonLabel}>{comparisonLabel}</AppText>}
                </View>
            </View>
        </AppCard>
    );
};

type CalorieBalanceStyles = ReturnType<typeof createStyles>;

const CalorieGauge: React.FC<{
    value: number | null;
    tone: 'primary' | 'danger';
    compact: boolean;
    narrow: boolean;
    colors: AppThemeColors;
    styles: CalorieBalanceStyles;
}> = ({ value, tone, compact, narrow, colors, styles }) => {
    const percentLabel = value === null ? '-' : `${Math.round(value * 100)}%`;
    const toneColor = tone === 'danger' ? colors.danger : colors.primary;
    let size = GAUGE_SIZE;
    if (compact) size = narrow ? NARROW_GAUGE_SIZE : COMPACT_GAUGE_SIZE;
    const stroke = compact ? COMPACT_GAUGE_STROKE : GAUGE_STROKE;
    const gaugeRadius = (size - stroke) / 2;
    const gaugeCircumference = 2 * Math.PI * gaugeRadius;
    const dashOffset = gaugeCircumference * (1 - (value ?? 0));
    // SVG rotation keeps the progress arc's zero point at 12 o'clock on native and web.
    const rotationTransform = `rotate(-90 ${size / 2} ${size / 2})`;

    return (
        <View accessibilityElementsHidden style={[styles.gauge, { minWidth: size, minHeight: size }]}>
            <Svg width="100%" height="100%" viewBox={`0 0 ${size} ${size}`} style={StyleSheet.absoluteFill}>
                <Circle
                    cx={size / 2}
                    cy={size / 2}
                    r={gaugeRadius}
                    fill="none"
                    stroke={colors.surfaceAlt}
                    strokeWidth={stroke}
                />
                {value !== null && <Circle
                    cx={size / 2}
                    cy={size / 2}
                    r={gaugeRadius}
                    fill="none"
                    testID="calorie-gauge-progress"
                    stroke={toneColor}
                    strokeWidth={stroke}
                    strokeLinecap="round"
                    strokeDasharray={`${gaugeCircumference} ${gaugeCircumference}`}
                    strokeDashoffset={dashOffset}
                    transform={rotationTransform}
                />}
            </Svg>
            <View style={[styles.gaugeLabel, { padding: stroke * 2 }]}>
                <AppText style={styles.gaugePercent}>{percentLabel}</AppText>
                <AppText style={styles.gaugeCaption}>eaten</AppText>
            </View>
        </View>
    );
};

function createStyles(colors: AppThemeColors) {
    return StyleSheet.create({
        surface: {
            backgroundColor: colors.summaryContainer,
            borderColor: colors.summaryOutline,
            shadowOpacity: 0,
            elevation: 0
        },
        primaryText: {
            color: colors.primary
        },
        open: { backgroundColor: 'transparent', borderWidth: 0, borderRadius: 0, paddingHorizontal: 0, paddingTop: spacing.sm, paddingBottom: spacing.lg, minHeight: 112 },
        openHeading: { fontWeight: '600' },
        dangerText: {
            color: colors.danger
        },
        hero: {
            flexDirection: 'row',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: spacing.md
        },
        heroCompact: {
            alignItems: 'center',
            gap: spacing.md
        },
        heroStacked: {
            flexDirection: 'column',
            alignItems: 'flex-start'
        },
        gauge: {
            flexShrink: 0,
            aspectRatio: 1,
            alignItems: 'center',
            justifyContent: 'center'
        },
        gaugeLabel: {
            alignItems: 'center',
            justifyContent: 'center'
        },
        gaugePercent: {
            color: colors.text,
            fontSize: 18,
            lineHeight: 22,
            fontWeight: '600'
        },
        gaugeCaption: {
            color: colors.muted,
            fontSize: 13,
            lineHeight: 18
        },
        balanceCopy: {
            // Intrinsic text width also handles browser text enlargement, which does not change fontScale.
            flexGrow: 1,
            flexShrink: 1,
            flexBasis: 'auto',
            minWidth: 'auto',
            maxWidth: '100%'
        },
        dividedCopy: {
            borderLeftWidth: StyleSheet.hairlineWidth,
            borderLeftColor: colors.summaryOutline,
            paddingLeft: spacing.md
        },
        balanceCopyStacked: {
            flex: 0,
            paddingTop: spacing.xs
        },
        balanceValue: {
            ...typeScale.metric,
            fontVariant: ['tabular-nums']
        },
        metricSlot: {
            justifyContent: 'center'
        },
        balanceValueCompact: {
            ...typeScale.compactMetric
        },
        balanceLabel: {
            color: colors.muted,
            fontSize: 16,
            lineHeight: 22,
            fontWeight: '600'
        },
        comparisonLabel: { color: colors.muted, marginTop: spacing.xs },
        unavailable: {
            color: colors.muted,
            fontSize: 20,
            lineHeight: 26,
            fontWeight: '600'
        }
    });
}
