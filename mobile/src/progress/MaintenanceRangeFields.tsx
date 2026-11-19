/** @file Shared maintenance setup controls and live preview of the lower limit, target, and upper limit. */

import { StyleSheet, View } from 'react-native';
import type { MaintenanceRange, WeightUnit } from '@calibrate/shared';
import { AppButton } from '../components/AppButton';
import { AppText } from '../components/AppText';
import { NumberStepperField } from '../components/NumberStepperField';
import type { ExternalFieldError, FocusableFormControl } from '../components/FormField';
import { useAppTheme, type AppTheme } from '../theme';
import { gramsToDisplayWeight } from '../utils/bodyMeasurements';
import { formatNumber, formatWeightUnit } from '../utils/format';
import type { ReactNode } from 'react';
import { MAINTENANCE_DISTANCE_LIMITS, maintenanceDistanceSteps } from './maintenanceRange';

/** Explain trend-based guidance and visualize the exact draft bounds alongside the target and range inputs. */
export function MaintenanceRangeFields({ range, valid, unit, targetField, distance, onDistanceChange, onUseCenteredRange, disabled, distanceError, distanceControlRef }: {
    range: MaintenanceRange;
    valid: boolean;
    unit: WeightUnit;
    targetField: ReactNode;
    distance: string;
    onDistanceChange: (value: string) => void;
    onUseCenteredRange?: () => void;
    disabled: boolean;
    distanceError?: ExternalFieldError;
    distanceControlRef?: React.RefObject<FocusableFormControl | null>;
}) {
    const theme = useAppTheme();
    const styles = createStyles(theme);
    const unitLabel = formatWeightUnit(unit);
    const precision = unit === 'KG' ? 2 : 1;
    const points = [
        { label: 'Lower limit', grams: range.lower_weight_grams },
        { label: 'Target', grams: range.target_weight_grams },
        { label: 'Upper limit', grams: range.upper_weight_grams }
    ];
    const span = range.upper_weight_grams - range.lower_weight_grams;
    const targetPosition = (range.target_weight_grams - range.lower_weight_grams) / span;
    return <View style={styles.fields}>
        <AppText variant="muted">
            Choose a target weight to maintain. If your weight trend moves outside your target range, we'll propose a plan to get back to your desired weight.
        </AppText>
        <View style={styles.controls}>
            <View style={styles.control}>{targetField}</View>
            {!onUseCenteredRange && <View style={styles.control}>
                <NumberStepperField label={`Range on either side (${unitLabel})`} value={distance}
                    onChangeText={onDistanceChange} step={MAINTENANCE_DISTANCE_LIMITS[unit].step}
                    stepValues={maintenanceDistanceSteps(unit)} editable={!disabled} externalError={distanceError} controlRef={distanceControlRef} />
            </View>}
        </View>
        {valid && <View style={styles.preview} testID="maintenance-range-preview">
            <View style={styles.trackInset} aria-hidden accessibilityElementsHidden>
                <View style={styles.track}>
                    <View style={[styles.trackHalf, { flex: targetPosition }]} />
                    <View style={styles.targetTick} />
                    <View style={[styles.trackHalf, { flex: 1 - targetPosition }]} />
                </View>
            </View>
            <View style={styles.points}>
                {points.map(({ label, grams }) => <View key={label} style={styles.point}>
                    <AppText variant="caption" style={styles.pointText}>{label}</AppText>
                    <AppText style={[styles.pointText, label === 'Target' && styles.targetWeight]}>
                        {formatNumber(Number(gramsToDisplayWeight(grams, unit, precision)), precision)} {unitLabel}
                    </AppText>
                </View>)}
            </View>
        </View>}
        {onUseCenteredRange && <View style={styles.unevenRange}>
            <AppText variant="muted">Your existing range has different distances above and below the target.</AppText>
            <AppButton title="Use a symmetric range" variant="secondary" disabled={disabled} onPress={onUseCenteredRange} />
        </View>}
    </View>;
}

// Let both controls share a row when there is room for the field labels and stepper buttons.
const RANGE_CONTROL_BASIS = 220;

function createStyles(theme: AppTheme) {
    return StyleSheet.create({
        fields: { gap: theme.spacing.md },
        unevenRange: { gap: theme.spacing.sm },
        controls: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.md },
        control: { flexBasis: RANGE_CONTROL_BASIS, flexGrow: 1, flexShrink: 1, minWidth: 0 },
        preview: {
            padding: theme.spacing.md, gap: theme.spacing.xs, borderRadius: theme.radius.md,
            borderWidth: theme.stroke.control, borderColor: theme.colors.outlineVariant, backgroundColor: theme.colors.surface
        },
        trackInset: { paddingHorizontal: '16.67%' },
        track: { flexDirection: 'row', alignItems: 'center', height: theme.spacing.lg, borderColor: theme.colors.primary, borderLeftWidth: theme.stroke.control, borderRightWidth: theme.stroke.control },
        trackHalf: { height: theme.spacing.sm, backgroundColor: theme.colors.primaryContainer },
        targetTick: { height: '100%', width: theme.interaction.focusRingWidth, backgroundColor: theme.colors.primary },
        points: { flexDirection: 'row', alignItems: 'baseline' },
        point: { flex: 1, minWidth: 0, alignItems: 'center' },
        pointText: { textAlign: 'center' },
        targetWeight: { color: theme.colors.primary, fontWeight: '600' }
    });
}
