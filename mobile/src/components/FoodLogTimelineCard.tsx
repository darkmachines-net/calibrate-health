/** @file Food Log Timeline Card: Full meal log with expansion for populated meals and snapshot edit/delete actions. */

import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View, useWindowDimensions, type ViewProps } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { FoodLogEntry } from '@calibrate/api-client';
import type { MealPeriod } from '@calibrate/shared';
import { AppText } from './AppText';
import { type AppTheme, useAppTheme } from '../theme';
import { formatCalories, formatMealPeriod } from '../utils/format';
import { MEAL_OPTIONS } from '../utils/meals';
import { getFoodLogAmountText } from '../food/foodLogAmount';

type FoodLogTimelineCardProps = ViewProps & {
    title?: string | null;
    entries: FoodLogEntry[];
    disabled?: boolean;
    copyDisabled?: boolean;
    onEditEntry: (entry: FoodLogEntry) => void;
    onDeleteEntry: (entry: FoodLogEntry) => void;
    onSaveMealAsRecipe?: (meal: MealPeriod, entries: FoodLogEntry[]) => void;
    onCopyMeal?: (meal: MealPeriod) => void;
    onCopyDay?: () => void;
};

type MealGroup = {
    meal: MealPeriod;
    entries: FoodLogEntry[];
    calories: number;
};

// Populated meals open at first render; empty rows remain compact and do not expose a disclosure control.
const DEFAULT_EXPANDED_MEALS: Record<MealPeriod, boolean> = {
    BREAKFAST: true,
    MORNING_SNACK: true,
    LUNCH: true,
    AFTERNOON_SNACK: true,
    DINNER: true,
    EVENING_SNACK: true
};

/**
 * Full meal log with expansion for populated meals and snapshot edit/delete actions.
 */
export const FoodLogTimelineCard: React.FC<FoodLogTimelineCardProps> = ({
    title = 'Food log',
    entries,
    disabled,
    copyDisabled,
    onEditEntry,
    onDeleteEntry,
    onSaveMealAsRecipe,
    onCopyMeal,
    onCopyDay,
    style,
    ...props
}) => {
    const [expandedMeals, setExpandedMeals] = useState<Record<MealPeriod, boolean>>(DEFAULT_EXPANDED_MEALS);
    const theme = useAppTheme();
    const styles = React.useMemo(() => createStyles(theme), [theme]);

    const mealGroups = useMemo<MealGroup[]>(() => {
        return MEAL_OPTIONS
            .map((meal) => {
                const mealEntries = entries.filter((entry) => entry.meal_period === meal);
                return {
                    meal,
                    entries: mealEntries,
                    calories: mealEntries.reduce((total, entry) => total + entry.calories, 0)
                };
            });
    }, [entries]);

    function toggleMeal(meal: MealPeriod) {
        setExpandedMeals((current) => ({ ...current, [meal]: !current[meal] }));
    }

    return (
        <View {...props} style={[styles.content, style]}>
            <View style={styles.headerRow}>
                <View style={styles.headerText}>
                    {title === null ? <AppText variant="muted">{entries.length} {entries.length === 1 ? 'food' : 'foods'} | {formatCalories(entries.reduce((total, entry) => total + entry.calories, 0))}</AppText>
                        : <AppText accessibilityRole="header" aria-level={2} variant="screenTitle">{title}</AppText>}
                </View>
                {entries.length > 0 && onCopyDay && (
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Copy day"
                        accessibilityState={{ disabled: Boolean(copyDisabled) }}
                        disabled={copyDisabled}
                        onPress={onCopyDay}
                        style={({ pressed }) => [
                            styles.headerAction,
                            copyDisabled && styles.disabled,
                            pressed && styles.pressed
                        ]}
                    >
                        <Ionicons name="copy-outline" size={18} color={theme.colors.primary} />
                        <AppText variant="label" style={styles.actionText}>Copy day</AppText>
                    </Pressable>
                )}
            </View>

            <View style={styles.mealList}>
                {mealGroups.map((group, index) => (
                    <MealTimelineRow
                        key={group.meal}
                        group={group}
                        isFirst={index === 0}
                        isExpanded={expandedMeals[group.meal]}
                        disabled={disabled}
                        copyDisabled={copyDisabled}
                        onEditEntry={onEditEntry}
                        onDeleteEntry={onDeleteEntry}
                        onSaveMealAsRecipe={onSaveMealAsRecipe}
                        onCopyMeal={onCopyMeal}
                        onToggleMeal={toggleMeal}
                    />
                ))}
            </View>
        </View>
    );
};

type MealTimelineRowProps = {
    group: MealGroup;
    isFirst: boolean;
    isExpanded: boolean;
    disabled?: boolean;
    copyDisabled?: boolean;
    onEditEntry: (entry: FoodLogEntry) => void;
    onDeleteEntry: (entry: FoodLogEntry) => void;
    onSaveMealAsRecipe?: (meal: MealPeriod, entries: FoodLogEntry[]) => void;
    onCopyMeal?: (meal: MealPeriod) => void;
    onToggleMeal: (meal: MealPeriod) => void;
};

const MealTimelineRow: React.FC<MealTimelineRowProps> = ({
    group,
    isFirst,
    isExpanded,
    disabled,
    copyDisabled,
    onEditEntry,
    onDeleteEntry,
    onSaveMealAsRecipe,
    onCopyMeal,
    onToggleMeal
}) => {
    const hasEntries = group.entries.length > 0;
    const theme = useAppTheme();
    const styles = React.useMemo(() => createStyles(theme), [theme]);
    const { fontScale } = useWindowDimensions();
    const useStackedLayout = fontScale >= 1.6;

    return (
        <View style={styles.mealRow}>
            <View style={styles.mealContent}>
                <View
                    style={[
                        styles.mealHeader,
                        !hasEntries && styles.emptyMealHeader,
                        useStackedLayout && styles.mealHeaderStacked,
                        !isFirst && styles.mealDivider
                    ]}
                >
                    <View style={styles.mealTitleRow}>
                        <AppText variant="body" numberOfLines={2} style={styles.mealTitle}>
                            {formatMealPeriod(group.meal)}
                        </AppText>
                    </View>
                    <View style={[styles.mealMetaRow, useStackedLayout && styles.mealMetaRowStacked]}>
                        <AppText style={hasEntries ? styles.mealCalories : styles.noEntries}>
                            {hasEntries ? formatCalories(group.calories) : 'No entries'}
                        </AppText>
                        {hasEntries ? (
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={`${isExpanded ? 'Collapse' : 'Expand'} ${formatMealPeriod(group.meal)}`}
                                onPress={() => onToggleMeal(group.meal)}
                                style={({ pressed }) => [styles.expandButton, pressed && styles.pressed]}
                            >
                                <Ionicons name={isExpanded ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.onSurfaceVariant} />
                            </Pressable>
                        ) : null}
                    </View>
                </View>
                {hasEntries && isExpanded && (
                    <View style={styles.entries}>
                        {group.entries.map((entry) => (
                            <FoodEntryRow
                                key={entry.id}
                                entry={entry}
                                disabled={disabled}
                                onEditEntry={onEditEntry}
                                onDeleteEntry={onDeleteEntry}
                            />
                        ))}
                        {(onCopyMeal || onSaveMealAsRecipe) && (
                            <View style={styles.mealActions}>
                                {onCopyMeal && (
                                    <Pressable
                                        accessibilityRole="button"
                                        accessibilityLabel={`Copy ${formatMealPeriod(group.meal)}`}
                                        accessibilityState={{ disabled: Boolean(copyDisabled) }}
                                        disabled={copyDisabled}
                                        onPress={() => onCopyMeal(group.meal)}
                                        style={({ pressed }) => [
                                            styles.mealAction,
                                            copyDisabled && styles.disabled,
                                            pressed && styles.pressed
                                        ]}
                                    >
                                        <Ionicons name="copy-outline" size={20} color={theme.colors.primary} />
                                        <AppText variant="label" style={styles.actionText}>Copy meal</AppText>
                                    </Pressable>
                                )}
                                {onSaveMealAsRecipe && (
                                    <Pressable
                                        accessibilityRole="button"
                                        accessibilityLabel={`Save ${formatMealPeriod(group.meal)} as recipe`}
                                        onPress={() => onSaveMealAsRecipe(group.meal, group.entries)}
                                        style={({ pressed }) => [styles.mealAction, pressed && styles.pressed]}
                                    >
                                        <Ionicons name="bookmark-outline" size={20} color={theme.colors.primary} />
                                        <AppText variant="label" style={styles.actionText}>Save as recipe</AppText>
                                    </Pressable>
                                )}
                            </View>
                        )}
                    </View>
                )}
            </View>
        </View>
    );
};

type FoodEntryRowProps = {
    entry: FoodLogEntry;
    disabled?: boolean;
    onEditEntry: (entry: FoodLogEntry) => void;
    onDeleteEntry: (entry: FoodLogEntry) => void;
};

const FoodEntryRow: React.FC<FoodEntryRowProps> = ({ entry, disabled, onEditEntry, onDeleteEntry }) => {
    const servingText = getFoodLogAmountText(entry);
    const theme = useAppTheme();
    const styles = React.useMemo(() => createStyles(theme), [theme]);
    const { fontScale } = useWindowDimensions();
    const useStackedLayout = fontScale >= 1.6;

    return (
        <View style={[styles.entryRow, useStackedLayout && styles.entryRowStacked]}>
            <View style={styles.entryText}>
                <AppText variant="body" numberOfLines={2}>{entry.name}</AppText>
                {servingText && <AppText variant="caption" numberOfLines={2}>{servingText}</AppText>}
            </View>
            <View style={[styles.entryMetaRow, useStackedLayout && styles.entryMetaRowStacked]}>
                <AppText variant="body" style={styles.entryCalories}>{formatCalories(entry.calories)}</AppText>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Edit ${entry.name}`}
                    disabled={disabled}
                    onPress={() => onEditEntry(entry)}
                    style={({ pressed }) => [styles.entryAction, disabled && styles.disabled, pressed && styles.pressed]}
                >
                    <Ionicons name="pencil" size={20} color={theme.colors.onSurfaceVariant} />
                </Pressable>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Delete ${entry.name}`}
                    disabled={disabled}
                    onPress={() => onDeleteEntry(entry)}
                    style={({ pressed }) => [styles.entryAction, disabled && styles.disabled, pressed && styles.pressed]}
                >
                    <Ionicons name="trash-outline" size={20} color={theme.colors.onSurfaceVariant} />
                </Pressable>
            </View>
        </View>
    );
};

function createStyles(theme: AppTheme) {
    return StyleSheet.create({
        content: {
            width: '100%',
            gap: theme.spacing.md
        },
        headerRow: {
            flexDirection: 'row',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
        gap: theme.spacing.md
    },
    headerText: {
        flex: 1,
        minWidth: 0,
        gap: theme.spacing.xs
    },
    headerAction: {
        minHeight: theme.interaction.minimumTouchTarget,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.xs,
        borderRadius: theme.radius.md,
        paddingHorizontal: theme.spacing.sm,
        overflow: 'hidden'
    },
    mealList: {
        marginTop: theme.spacing.xs
    },
    mealRow: {
        minHeight: 0
    },

    mealContent: {
        flex: 1,
        minWidth: 0
    },
    mealHeader: {
        minHeight: 56,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.spacing.xs
    },
    emptyMealHeader: {
        // Match Today's compact meal rhythm while populated headers retain room for their controls.
        minHeight: theme.interaction.minimumTouchTarget
    },
    mealHeaderStacked: {
        alignItems: 'stretch',
        flexDirection: 'column',
        paddingVertical: theme.spacing.sm
    },
    mealDivider: {
        borderTopColor: theme.colors.outlineVariant,
        borderTopWidth: StyleSheet.hairlineWidth
    },
    mealTitleRow: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.sm
    },
    mealTitle: {
        flex: 1,
        minWidth: 0,
        fontWeight: '600'
    },
    mealMetaRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.xs,
        flexShrink: 0
    },
    mealMetaRowStacked: {
        alignSelf: 'stretch',
        justifyContent: 'flex-end'
    },
    mealCalories: {
        color: theme.colors.onSurfaceVariant,
        fontWeight: '600',
        textAlign: 'right',
        fontSize: 14
    },
    noEntries: {
        ...theme.typography.styles.label,
        fontWeight: '400',
        color: theme.colors.onSurfaceVariant,
        textAlign: 'right'
    },
    expandButton: {
        width: theme.interaction.minimumTouchTarget,
        height: theme.interaction.minimumTouchTarget,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: theme.radius.md,
        overflow: 'hidden'
    },
    entries: {
        borderTopColor: theme.colors.outlineVariant,
        borderTopWidth: StyleSheet.hairlineWidth
    },
    entryRow: {
        minHeight: 64,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.sm,
        borderBottomColor: theme.colors.outlineVariant,
        borderBottomWidth: StyleSheet.hairlineWidth
    },
    entryRowStacked: {
        alignItems: 'stretch',
        flexDirection: 'column',
        paddingVertical: theme.spacing.sm
    },
    entryText: {
        flex: 1,
        minWidth: 0
    },
    entryCalories: {
        color: theme.colors.onSurfaceVariant,
        textAlign: 'right'
    },
    entryMetaRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.xs
    },
    entryMetaRowStacked: {
        alignSelf: 'stretch',
        justifyContent: 'flex-end'
    },
    entryAction: {
        width: theme.interaction.minimumTouchTarget,
        height: theme.interaction.minimumTouchTarget,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: theme.radius.md,
        overflow: 'hidden'
    },
    mealActions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'flex-end',
        gap: theme.spacing.xs,
        paddingVertical: theme.spacing.xs
    },
    mealAction: {
        minHeight: theme.interaction.minimumTouchTarget,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.spacing.xs,
        borderRadius: theme.radius.md,
        paddingHorizontal: theme.spacing.sm,
        overflow: 'hidden'
    },
    actionText: {
        color: theme.colors.primary
    },
    disabled: {
        opacity: 0.45
    },
    pressed: {
        backgroundColor: theme.colors.surfacePressed
    }
    });
}
