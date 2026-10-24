/** @file Save Meal As Recipe Sheet: Create a reusable immutable recipe from selected entries in one logged meal. */

import React, { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import type { FoodLogEntry } from '@calibrate/api-client';
import type { MealPeriod } from '@calibrate/shared';
import { useAuth } from '../auth/AuthContext';
import { SAVED_FOODS_LIBRARY_QUERY_KEY } from '../savedFoods/queryKeys';
import { getFoodLogAmountText } from '../food/foodLogAmount';
import { formatDateOnlyForDisplay } from '../utils/dates';
import { formatCalories, formatMealPeriod } from '../utils/format';
import { type AppTheme, useAppTheme } from '../theme';
import { AppButton } from './AppButton';
import { AppText } from './AppText';
import { BottomSheetModal } from './BottomSheetModal';
import { NumberStepperField } from './NumberStepperField';
import { TextField } from './TextField';
import { getSafeActionErrorMessage } from '../errors/presentation';
import { confirmDiscardChanges } from './confirmDiscardChanges';

type SaveMealAsRecipeSheetProps = {
    visible: boolean;
    date: string;
    meal: MealPeriod | null;
    entries: FoodLogEntry[];
    onClose: () => void;
    onSaved: (recipeName: string) => void;
};

/** Create a reusable immutable recipe from selected entries in one logged meal. */
export const SaveMealAsRecipeSheet: React.FC<SaveMealAsRecipeSheetProps> = ({
    visible,
    date,
    meal,
    entries,
    onClose,
    onSaved
}) => {
    const { api } = useAuth();
    const queryClient = useQueryClient();
    const theme = useAppTheme();
    const { fontScale } = useWindowDimensions();
    const styles = useMemo(() => createStyles(theme), [theme]);
    const [name, setName] = useState('');
    const [yieldServings, setYieldServings] = useState('1');
    const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());

    const saveRecipe = useMutation({
        mutationFn: () => api.createRecipeFromFoodLogs({
            name: name.trim(),
            yield_servings: Number(yieldServings),
            food_log_ids: entries.filter((entry) => selectedIds.has(entry.id)).map((entry) => entry.id)
        }),
        onSuccess: async () => {
            const savedName = name.trim();
            await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: ['mobile-my-foods'] }),
                queryClient.invalidateQueries({ queryKey: SAVED_FOODS_LIBRARY_QUERY_KEY })
            ]);
            onSaved(savedName);
        }
    });

    useEffect(() => {
        if (!visible) return;
        setName('');
        setYieldServings('1');
        setSelectedIds(new Set(entries.map((entry) => entry.id)));
        saveRecipe.reset();
        // Reset exactly when a new contextual save flow opens.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible, meal, date]);

    const selectedEntries = entries.filter((entry) => selectedIds.has(entry.id));
    const totalCalories = selectedEntries.reduce((total, entry) => total + entry.calories, 0);
    const parsedYield = Number(yieldServings);
    const hasValidYield = Number.isFinite(parsedYield) && parsedYield > 0;
    const caloriesPerServing = hasValidYield ? totalCalories / parsedYield : null;
    const canSave = name.trim().length > 0 && selectedEntries.length > 0 && hasValidYield && !saveRecipe.isPending;
    const selectionChanged = selectedIds.size !== entries.length
        || entries.some((entry) => !selectedIds.has(entry.id));
    const hasUnsavedDraft = Boolean(name.trim() || yieldServings !== '1' || selectionChanged);

    async function handleCancel() {
        if (!hasUnsavedDraft || await confirmDiscardChanges()) onClose();
    }

    function toggleEntry(id: number) {
        setSelectedIds((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }

    return (
        <BottomSheetModal
            visible={visible}
            accessibilityLabel="Save as recipe"
            title="Save as recipe"
            description={meal ? `${formatMealPeriod(meal)} | ${formatDateOnlyForDisplay(date)}` : formatDateOnlyForDisplay(date)}
            maxHeight="92%"
            showCloseButton
            dismissDisabled={saveRecipe.isPending}
            isDirty={hasUnsavedDraft}
            confirmDismiss={confirmDiscardChanges}
            onRequestClose={onClose}
        >
            <TextField
                label="Recipe name"
                value={name}
                onChangeText={setName}
                placeholder="e.g. Margarita"
                editable={!saveRecipe.isPending}
            />
            <NumberStepperField
                label="These items make"
                value={yieldServings}
                onChangeText={setYieldServings}
                step={1}
                min={1}
                suffix="servings"
                editable={!saveRecipe.isPending}
            />
            <AppText variant="label">Ingredients</AppText>
            <View style={styles.ingredientList}>
                {entries.map((entry) => {
                    const checked = selectedIds.has(entry.id);
                    const amount = getFoodLogAmountText(entry);
                    return (
                        <Pressable
                            key={entry.id}
                            aria-checked={checked}
                            accessibilityRole="checkbox"
                            accessibilityLabel={`${checked ? 'Exclude' : 'Include'} ${entry.name}`}
                            accessibilityState={{ checked }}
                            disabled={saveRecipe.isPending}
                            onPress={() => toggleEntry(entry.id)}
                            style={({ pressed }) => [
                                styles.ingredientRow,
                                checked && styles.ingredientRowSelected,
                                pressed && styles.pressed
                            ]}
                        >
                            <View style={[styles.checkbox, checked && styles.checkboxSelected]}>
                                {checked && <Ionicons name="checkmark" size={18} color={theme.colors.onPrimary} />}
                            </View>
                            <View style={styles.ingredientText}>
                                <AppText variant="body" numberOfLines={2}>{entry.name}</AppText>
                                <AppText variant="caption">
                                    {[amount, formatCalories(entry.calories)].filter(Boolean).join(' | ')}
                                </AppText>
                            </View>
                        </Pressable>
                    );
                })}
            </View>
            <View
                accessible
                accessibilityLiveRegion="polite"
                accessibilityLabel={`${selectedEntries.length} selected, ${formatCalories(totalCalories)} total${caloriesPerServing === null ? '' : `, ${formatCalories(caloriesPerServing)} per serving`}`}
                style={styles.summary}
            >
                <AppText variant="subtitle">{formatCalories(totalCalories)} total</AppText>
                <AppText variant="caption">
                    {selectedEntries.length} item{selectedEntries.length === 1 ? '' : 's'} selected
                    {caloriesPerServing === null ? '' : ` | ${formatCalories(caloriesPerServing)} per serving`}
                </AppText>
            </View>
            {selectedEntries.length === 0 && (
                <AppText accessibilityRole="alert" style={styles.error}>Select at least one ingredient.</AppText>
            )}
            {!hasValidYield && (
                <AppText accessibilityRole="alert" style={styles.error}>Yield must be a positive number.</AppText>
            )}
            {saveRecipe.error && (
                <AppText accessibilityRole="alert" style={styles.error}>
                    {getSafeActionErrorMessage(saveRecipe.error, 'Unable to save this recipe.')}
                </AppText>
            )}
            <View style={[styles.actions, fontScale >= 1.3 && styles.actionsStacked]}>
                <AppButton
                    title="Cancel"
                    variant="secondary"
                    disabled={saveRecipe.isPending}
                    onPress={() => { void handleCancel(); }}
                    style={styles.action}
                />
                <AppButton
                    title={saveRecipe.isPending ? 'Saving...' : 'Save recipe'}
                    disabled={!canSave}
                    leftIcon={<Ionicons name="checkmark" size={18} color={canSave ? theme.colors.onPrimary : theme.colors.onSurfaceVariant} />}
                    onPress={() => saveRecipe.mutate()}
                    style={styles.action}
                />
            </View>
        </BottomSheetModal>
    );
};

const createStyles = (theme: AppTheme) => StyleSheet.create({
    ingredientList: {
        gap: theme.spacing.sm
    },
    ingredientRow: {
        minHeight: theme.interaction.minimumTouchTarget,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.outlineVariant,
        paddingVertical: theme.spacing.md
    },
    ingredientRowSelected: {
        borderColor: theme.colors.primary,
        backgroundColor: theme.colors.primaryContainer
    },
    checkbox: {
        width: 28,
        height: 28,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: theme.radius.sm,
        borderWidth: theme.stroke.control,
        borderColor: theme.colors.outline,
        backgroundColor: theme.colors.surface
    },
    checkboxSelected: {
        borderColor: theme.colors.primary,
        backgroundColor: theme.colors.primary
    },
    ingredientText: {
        flex: 1,
        minWidth: 0,
        gap: theme.spacing.xs
    },
    summary: {
        gap: theme.spacing.xs,
        paddingVertical: theme.spacing.md,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.outlineVariant
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
    pressed: {
        opacity: 0.82
    },
    error: {
        color: theme.colors.danger
    }
});
