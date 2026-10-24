import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, View, useWindowDimensions } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { FoodLogCreatePayload } from '@calibrate/api-client';
import type { MealPeriod } from '@calibrate/shared';
import { AppButton } from './AppButton';
import { AppText } from './AppText';
import { AppIconButton } from './AppIconButton';
import { NumberStepperField } from './NumberStepperField';
import { OverlaySelect, type OverlaySelectOption } from './OverlaySelect';
import {
    buildFoodSelectionPayload,
    changeFoodSelectionMeasure,
    createFoodSelectionDraft,
    describeFoodSelection,
    getFoodSelectionStep,
    getFoodSelectionUnit,
    isManualRecentSelection,
    type FoodLogSelection
} from '../food/foodLogSelection';
import { MINIMUM_FOOD_QUANTITY } from '../food/quantityInput';
import { formatCalories } from '../utils/format';
import { spacing, useAppTheme, type AppTheme } from '../theme';

export type FoodSelectionSubmitRequest = {
    payload: FoodLogCreatePayload;
    closeAfterLogging: boolean;
};

type FoodSelectionEditorProps = {
    selection: FoodLogSelection;
    date: string;
    meal: MealPeriod;
    isSubmitting?: boolean;
    error?: string | null;
    onCancel: () => void;
    onSubmit: (request: FoodSelectionSubmitRequest) => void;
};

/** Shared confirmation editor used after choosing any reusable food source. */
export const FoodSelectionEditor: React.FC<FoodSelectionEditorProps> = ({
    selection,
    date,
    meal,
    isSubmitting = false,
    error,
    onCancel,
    onSubmit
}) => {
    const theme = useAppTheme();
    const { fontScale } = useWindowDimensions();
    const styles = useMemo(() => createStyles(theme), [theme]);
    const [draft, setDraft] = useState(() => createFoodSelectionDraft(selection));
    const [isMeasureSelectorOpen, setIsMeasureSelectorOpen] = useState(false);
    const selectionKeyRef = useRef(selection.key);

    useEffect(() => {
        // Refreshing the same food must preserve the user's serving edits.
        if (selectionKeyRef.current === selection.key) return;
        selectionKeyRef.current = selection.key;
        setDraft(createFoodSelectionDraft(selection));
        setIsMeasureSelectorOpen(false);
    }, [selection]);

    const result = buildFoodSelectionPayload({ selection, draft, date, meal });
    const measureOptions: Array<OverlaySelectOption<string>> = selection.kind === 'provider'
        ? selection.item.measures.map((measure, index) => ({
              value: String(index),
              label: measure.label,
              description: measure.gramWeight === 1
                  ? 'Enter the food weight in grams'
                  : `${measure.gramWeight} g per measure`
          }))
        : [];
    const manualCalories = isManualRecentSelection(selection);
    const quantityUnit = getFoodSelectionUnit(selection, draft);
    const isGramUnit = ['g', 'gram', 'grams'].includes(quantityUnit.trim().toLowerCase());
    const quantityStep = getFoodSelectionStep(selection, draft);

    function submit(closeAfterLogging: boolean) {
        if (!result.ok) return;
        onSubmit({ payload: result.payload, closeAfterLogging });
    }

    return (
        <View style={styles.root}>
            <View style={styles.header}>
                <AppIconButton
                    icon="arrow-back"
                    accessibilityLabel="Back to food results"
                    disabled={isSubmitting}
                    onPress={onCancel}
                />
                <View style={styles.foodText}>
                    <AppText accessibilityRole="header" aria-level={3} variant="subtitle" numberOfLines={2}>
                        {selection.name}
                    </AppText>
                    <AppText variant="caption" numberOfLines={2}>{describeFoodSelection(selection)}</AppText>
                </View>
            </View>

            {measureOptions.length > 1 && (
                <View style={styles.fieldGroup}>
                    <AppText variant="label">Unit</AppText>
                    <OverlaySelect
                        accessibilityLabel="Select food unit"
                        value={draft.measureIndex}
                        options={measureOptions}
                        isOpen={isMeasureSelectorOpen}
                        onToggle={() => setIsMeasureSelectorOpen((current) => !current)}
                        onChange={(nextIndex) => {
                            setDraft((current) => changeFoodSelectionMeasure(selection, current, nextIndex));
                            setIsMeasureSelectorOpen(false);
                        }}
                    />
                </View>
            )}

            {manualCalories ? (
                <NumberStepperField
                    label="Calories"
                    value={draft.calories}
                    onChangeText={(calories) => setDraft((current) => ({ ...current, calories }))}
                    step={25}
                    min={0}
                    suffix="kcal"
                    editable={!isSubmitting}
                />
            ) : (
                <NumberStepperField
                    label={isGramUnit ? 'Weight' : 'Amount'}
                    value={draft.quantity}
                    onChangeText={(quantity) => setDraft((current) => ({ ...current, quantity }))}
                    step={quantityStep}
                    min={MINIMUM_FOOD_QUANTITY}
                    suffix={quantityUnit}
                    helperText={`Use +/- ${quantityStep} ${quantityUnit}; type any positive decimal.`}
                    editable={!isSubmitting}
                />
            )}

            {result.ok ? (
                <View
                    accessible
                    accessibilityLiveRegion="polite"
                    accessibilityLabel={`${formatCalories(result.calories)}, ${result.amountDescription}`}
                    style={styles.summary}
                >
                    <AppText variant="metric">{formatCalories(result.calories)}</AppText>
                    <AppText variant="caption">{result.amountDescription}</AppText>
                </View>
            ) : (
                <AppText accessibilityRole="alert" style={styles.error}>{result.message}</AppText>
            )}
            {error && <AppText accessibilityRole="alert" style={styles.error}>{error}</AppText>}

            <View style={[styles.actions, fontScale >= 1.3 && styles.actionsStacked]}>
                <AppButton
                    title={isSubmitting ? 'Adding...' : 'Add another'}
                    variant="secondary"
                    disabled={isSubmitting || !result.ok}
                    leftIcon={<Ionicons name="add" size={18} color={theme.colors.onSurface} />}
                    onPress={() => submit(false)}
                    style={styles.actionButton}
                />
                <AppButton
                    title={isSubmitting ? 'Adding...' : 'Add & close'}
                    disabled={isSubmitting || !result.ok}
                    leftIcon={<Ionicons name="checkmark" size={18} color={theme.colors.onPrimary} />}
                    onPress={() => submit(true)}
                    style={styles.actionButton}
                />
            </View>
        </View>
    );
};

const createStyles = (theme: AppTheme) => StyleSheet.create({
    root: {
        gap: spacing.md
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md
    },
    foodText: {
        flex: 1,
        minWidth: 0,
        gap: spacing.xs
    },
    fieldGroup: {
        gap: spacing.sm
    },
    summary: {
        gap: spacing.xs,
        paddingVertical: spacing.lg,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.outlineVariant
    },
    actions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.md
    },
    actionsStacked: { flexDirection: 'column' },
    actionButton: {
        flex: 1,
        minWidth: Platform.OS === 'web' ? 'auto' : 0
    },
    error: {
        color: theme.colors.danger
    }
});
