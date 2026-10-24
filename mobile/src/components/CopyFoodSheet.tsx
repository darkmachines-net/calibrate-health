/** @file Meal/day copy selection, destination date validation, and submission recovery UI. */

import React, { useEffect, useMemo, useState } from 'react';
import { Platform, StyleSheet, View, useWindowDimensions } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { MealPeriod } from '@calibrate/shared';
import { addDaysToDateOnly, clampDateOnly, formatDateOnlyForDisplay } from '../utils/dates';
import { formatMealPeriod } from '../utils/format';
import { MEAL_OPTIONS, MEAL_SELECT_OPTIONS } from '../utils/meals';
import { type AppTheme, useAppTheme } from '../theme';
import { AppButton } from './AppButton';
import { AppText } from './AppText';
import { BottomSheetModal } from './BottomSheetModal';
import { DatePickerField } from './DatePickerField';
import { OverlaySelect } from './OverlaySelect';

export type FoodCopySource =
    | { kind: 'meal'; meal: MealPeriod }
    | { kind: 'day' };

export type FoodCopySelection =
    | { kind: 'meal'; targetDate: string; targetMeal: MealPeriod }
    | { kind: 'day'; targetDate: string };

type CopyFoodSheetProps = {
    visible: boolean;
    source: FoodCopySource | null;
    sourceDate: string;
    minDate: string;
    maxDate: string;
    isSubmitting?: boolean;
    error?: string | null;
    onRequestClose: () => void;
    onSubmit: (selection: FoodCopySelection) => void;
};

/** Prefers the following day for copying, otherwise the preceding day, clamped to the allowed range. */
export function getDefaultCopyTargetDate(sourceDate: string, minDate: string, maxDate: string): string {
    if (sourceDate < maxDate) return clampDateOnly(addDaysToDateOnly(sourceDate, 1), minDate, maxDate);
    if (sourceDate > minDate) return clampDateOnly(addDaysToDateOnly(sourceDate, -1), minDate, maxDate);
    return sourceDate;
}

/** Collects a bounded destination date and meal for copying food snapshots, retaining caller-owned submission state. */
export const CopyFoodSheet: React.FC<CopyFoodSheetProps> = ({
    visible,
    source,
    sourceDate,
    minDate,
    maxDate,
    isSubmitting = false,
    error,
    onRequestClose,
    onSubmit
}) => {
    const theme = useAppTheme();
    const { fontScale } = useWindowDimensions();
    const styles = useMemo(() => createStyles(theme), [theme]);
    const [targetDate, setTargetDate] = useState(() => getDefaultCopyTargetDate(sourceDate, minDate, maxDate));
    const [targetMeal, setTargetMeal] = useState<MealPeriod>('BREAKFAST');
    const [isMealSelectorOpen, setIsMealSelectorOpen] = useState(false);

    useEffect(() => {
        if (!visible || !source) return;
        const nextTargetDate = getDefaultCopyTargetDate(sourceDate, minDate, maxDate);
        setTargetDate(nextTargetDate);
        setTargetMeal(source.kind === 'meal' ? source.meal : 'BREAKFAST');
        setIsMealSelectorOpen(false);
    }, [maxDate, minDate, source, sourceDate, visible]);

    if (!source) return null;

    const isSameDay = targetDate === sourceDate;
    const isSameMeal = source.kind === 'meal' && targetMeal === source.meal;
    let validationMessage: string | null = null;
    if (source.kind === 'day' && isSameDay) {
        validationMessage = 'Choose a different day.';
    } else if (source.kind === 'meal' && isSameDay && isSameMeal) {
        validationMessage = 'Choose a different day or meal.';
    }
    const sourceLabel = source.kind === 'meal' ? formatMealPeriod(source.meal) : 'all meals';
    const actionLabel = source.kind === 'meal' ? 'Copy meal' : 'Copy day';

    function submit() {
        if (validationMessage) return;
        if (source?.kind === 'meal') {
            onSubmit({ kind: 'meal', targetDate, targetMeal });
            return;
        }
        onSubmit({ kind: 'day', targetDate });
    }

    return (
        <BottomSheetModal
            visible={visible}
            title={actionLabel}
            description={`Copy ${sourceLabel} from ${formatDateOnlyForDisplay(sourceDate)}.`}
            accessibilityLabel={actionLabel}
            showCloseButton
            dismissDisabled={isSubmitting}
            onRequestClose={onRequestClose}
        >
            <DatePickerField
                label="Copy to date"
                value={targetDate}
                minimumDate={minDate}
                maximumDate={maxDate}
                onChangeDate={setTargetDate}
            />
            {source.kind === 'meal' && (
                <View style={styles.fieldGroup}>
                    <AppText variant="label">Copy to meal</AppText>
                    <OverlaySelect
                        accessibilityLabel="Copy to meal"
                        value={targetMeal}
                        options={MEAL_SELECT_OPTIONS}
                        isOpen={isMealSelectorOpen}
                        onToggle={() => setIsMealSelectorOpen((current) => !current)}
                        onChange={(nextMeal) => {
                            if (!MEAL_OPTIONS.includes(nextMeal)) return;
                            setTargetMeal(nextMeal);
                            setIsMealSelectorOpen(false);
                        }}
                    />
                </View>
            )}
            {validationMessage && (
                <AppText accessibilityRole="alert" style={styles.error}>{validationMessage}</AppText>
            )}
            {error && <AppText accessibilityRole="alert" style={styles.error}>{error}</AppText>}
            <View style={[styles.actions, fontScale >= 1.3 && styles.actionsStacked]}>
                <AppButton
                    title="Cancel"
                    variant="secondary"
                    disabled={isSubmitting}
                    leftIcon={<Ionicons name="close" size={18} color={theme.colors.onSurface} />}
                    onPress={onRequestClose}
                    style={styles.action}
                />
                <AppButton
                    title={isSubmitting ? 'Copying...' : actionLabel}
                    disabled={isSubmitting || Boolean(validationMessage)}
                    leftIcon={<Ionicons name="copy-outline" size={18} color={theme.colors.onPrimary} />}
                    onPress={submit}
                    style={styles.action}
                />
            </View>
        </BottomSheetModal>
    );
};

const createStyles = (theme: AppTheme) => StyleSheet.create({
    fieldGroup: {
        gap: theme.spacing.sm
    },
    actions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: theme.spacing.md
    },
    actionsStacked: { flexDirection: 'column' },
    action: {
        flex: 1,
        minWidth: Platform.OS === 'web' ? 'auto' : 0
    },
    error: {
        color: theme.colors.danger
    }
});
