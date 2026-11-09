/** @file Static sample week that illustrates comparing food logs with a daily target. */
import { StyleSheet, View } from 'react-native';
import { AppText } from '../AppText';
import { radius, spacing, useAppTheme } from '../../theme';

// Example values use the same vertical scale as the target line and start at zero.
const EXAMPLE_DAYS = [
    { day: 'Monday', calories: 1620 },
    { day: 'Tuesday', calories: 2010 },
    { day: 'Wednesday', calories: 1810 },
    { day: 'Thursday', calories: 2260 },
    { day: 'Friday', calories: 1900 },
    { day: 'Saturday', calories: 2130 },
    { day: 'Sunday', calories: 1840 }
] as const;
const EXAMPLE_TARGET = 2000;
const EXAMPLE_SCALE_MAX = 2560;
// Reserve room for readable day labels without letting artwork dominate short screens.
const PLOT_HEIGHT = 112;
const MAX_BAR_WIDTH = 32;

/** Render an illustrative week with an accessible summary and no dependence on user data. */
export function WelcomeCalories() {
    const { colors } = useAppTheme();
    return (
        <View
            accessible
            accessibilityRole="image"
            accessibilityLabel="Sample week of daily calories compared with a 2,000 kcal target"
            style={[styles.figure, { backgroundColor: colors.summaryContainer }]}
        >
            <View style={styles.caption}>
                <AppText variant="label" style={{ color: colors.onSurface }}>Daily calories</AppText>
                <AppText variant="caption">Sample week</AppText>
            </View>
            <View style={[styles.plot, { borderBottomColor: colors.summaryOutline }]}>
                {EXAMPLE_DAYS.map(({ day, calories }, index) => (
                    <View key={day} style={styles.day}>
                        <View style={[styles.bar, {
                            height: `${calories / EXAMPLE_SCALE_MAX * 100}%`,
                            backgroundColor: index === EXAMPLE_DAYS.length - 1 ? colors.primary : colors.primaryContainer
                        }]} />
                    </View>
                ))}
                <View style={[styles.target, {
                    bottom: `${EXAMPLE_TARGET / EXAMPLE_SCALE_MAX * 100}%`,
                    borderColor: colors.primary
                }]}>
                    <AppText variant="caption" style={[styles.targetLabel, {
                        color: colors.primary, backgroundColor: colors.summaryContainer
                    }]}>2,000 kcal target</AppText>
                </View>
            </View>
            <View style={styles.days} aria-hidden>
                {EXAMPLE_DAYS.map(({ day }) => (
                    <AppText key={day} variant="caption" style={styles.dayLabel}>{day.charAt(0)}</AppText>
                ))}
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    figure: { borderRadius: radius.lg, gap: spacing.sm, padding: spacing.md },
    caption: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: spacing.xs },
    plot: { height: PLOT_HEIGHT, flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth },
    day: { flex: 1, justifyContent: 'flex-end', alignItems: 'center' },
    bar: { width: '70%', maxWidth: MAX_BAR_WIDTH, borderTopLeftRadius: radius.sm, borderTopRightRadius: radius.sm },
    target: { position: 'absolute', left: 0, right: 0, borderTopWidth: 1, borderStyle: 'dashed' },
    targetLabel: { position: 'absolute', bottom: -spacing.sm, left: 0, paddingRight: spacing.xs },
    days: { flexDirection: 'row' },
    dayLabel: { flex: 1, textAlign: 'center' }
});
