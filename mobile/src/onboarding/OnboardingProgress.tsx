/** @file Onboarding Progress: Renders a bounded, accessible onboarding step indicator without competing with the page heading. */

import { StyleSheet, View } from 'react-native';
import { AppText } from '../components/AppText';
import { radius, spacing, useAppTheme } from '../theme';
import { ONBOARDING_STEPS } from './steps';

const PROGRESS_TRACK_HEIGHT = 4; // A quiet progress cue leaves the page heading in focus.

/** Renders a bounded, accessible onboarding step indicator without competing with the page heading. */
export function OnboardingProgress({ activeIndex }: { activeIndex: number }) {
    const { colors } = useAppTheme();
    const current = Math.min(Math.max(activeIndex + 1, 1), ONBOARDING_STEPS.length);
    const text = `Step ${current} of ${ONBOARDING_STEPS.length}`;
    return (
        <View style={styles.root}>
            <AppText variant="caption">{text}</AppText>
            <View accessible accessibilityRole="progressbar" accessibilityLabel="Onboarding progress"
                accessibilityValue={{ min: 1, max: ONBOARDING_STEPS.length, now: current, text }}
                style={styles.track}>
                {ONBOARDING_STEPS.map((step, index) => (
                    <View key={step.key} style={[styles.segment, {
                        backgroundColor: index < current ? colors.primary : colors.outlineVariant
                    }]} />
                ))}
            </View>
        </View>
    );
}
const styles = StyleSheet.create({
    root: { gap: spacing.sm },
    track: { flexDirection: 'row', gap: spacing.sm },
    segment: { flex: 1, height: PROGRESS_TRACK_HEIGHT, borderRadius: radius.pill }
});
