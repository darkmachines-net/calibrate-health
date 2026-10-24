/** @file Barcode Manual Food Form: Collects a manual food fallback for a barcode and submits only a finite nonnegative calorie value. */

import { StyleSheet, View } from 'react-native';
import type { FoodLogCreatePayload } from '@calibrate/api-client';
import type { MealPeriod } from '@calibrate/shared';
import { AppButton } from '../components/AppButton';
import { TextField } from '../components/TextField';
import { spacing } from '../theme';

type BarcodeManualFoodFormProps = {
    date: string;
    meal: MealPeriod;
    barcode: string | null;
    isSubmitting: boolean;
    error: string | null;
    name: string;
    calories: string;
    onNameChange: (value: string) => void;
    onCaloriesChange: (value: string) => void;
    onCancel: () => void;
    onSubmit: (request: { payload: FoodLogCreatePayload; closeAfterLogging: boolean }) => void;
};

/** Collects a manual food fallback for a barcode and submits only a finite nonnegative calorie value. */
export function BarcodeManualFoodForm({
    date,
    meal,
    barcode,
    isSubmitting,
    error,
    name,
    calories,
    onNameChange,
    onCaloriesChange,
    onCancel,
    onSubmit
}: BarcodeManualFoodFormProps) {
    const calorieValue = Number(calories);
    const canSubmit = calories.trim().length > 0
        && Number.isFinite(calorieValue)
        && calorieValue >= 0;

    function submit(closeAfterLogging: boolean) {
        if (!canSubmit) return;
        onSubmit({
            closeAfterLogging,
            payload: {
                date,
                meal_period: meal,
                name: name.trim() || 'Manual entry',
                calories: Math.round(calorieValue),
                barcode
            }
        });
    }

    return (
        <View style={styles.form}>
            <TextField
                label="Food name"
                value={name}
                editable={!isSubmitting}
                placeholder="Optional"
                returnKeyType="next"
                onChangeText={onNameChange}
            />
            <TextField
                label="Calories"
                value={calories}
                editable={!isSubmitting}
                required
                keyboardType="number-pad"
                inputMode="numeric"
                errorText={error ?? (calories.trim().length > 0 && !canSubmit
                    ? 'Enter zero or more calories.'
                    : undefined)}
                onChangeText={onCaloriesChange}
                onSubmitEditing={() => submit(true)}
            />
            <AppButton
                title="Add food"
                busy={isSubmitting}
                busyLabel="Adding food..."
                disabled={!canSubmit}
                onPress={() => submit(true)}
            />
            <AppButton
                title="Add and scan another"
                variant="secondary"
                disabled={!canSubmit || isSubmitting}
                onPress={() => submit(false)}
            />
            <AppButton
                title="Cancel manual entry"
                variant="ghost"
                disabled={isSubmitting}
                onPress={onCancel}
            />
        </View>
    );
}

const styles = StyleSheet.create({ form: { gap: spacing.md } });
