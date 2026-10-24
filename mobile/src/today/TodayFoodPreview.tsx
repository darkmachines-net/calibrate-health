/** @file Today Food Preview: Presents the day's meal summary as a focusable entry point into the food log. */

import React from 'react';
import { Pressable, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { FoodLogEntry } from '@calibrate/api-client';
import { AppText } from '../components/AppText';
import { FixedPageColumn } from '../components/FixedPage';
import { useFocusVisible } from '../components/useFocusVisible';
import { type AppTheme, useAppTheme } from '../theme';
import { formatCalories, formatMealPeriod } from '../utils/format';
import { getTodayFoodMeals } from './foodPreview';

type TodayFoodPreviewProps = {
    entries: FoodLogEntry[];
    onPress: () => void;
    style?: StyleProp<ViewStyle>;
    expanded?: boolean;
};

/** Presents the day's meal summary as a focusable entry point into the food log. */
export function TodayFoodPreview({ entries, onPress, style, expanded = false }: TodayFoodPreviewProps) {
    const theme = useAppTheme();
    const styles = React.useMemo(() => createStyles(theme), [theme]);
    const meals = React.useMemo(() => getTodayFoodMeals(entries), [entries]);
    const [hovered, setHovered] = React.useState(false);
    const { focusVisible, handleFocus, handleBlur } = useFocusVisible();
    const foodCount = `${entries.length} ${entries.length === 1 ? 'food' : 'foods'}`;
    const accessibleMeals = entries.length ? meals.map((meal) => (
        `${formatMealPeriod(meal.meal)}, ${meal.entryCount ? formatCalories(meal.calories) : 'No entries'}.`
    )).join(' ') : 'No food logged yet.';

    const content = <Pressable
        testID="today-food-preview"
        accessibilityRole="button"
        accessibilityLabel={`Food log. ${foodCount}. ${accessibleMeals} View full log`}
        accessibilityHint="Expands the detailed food log below the date picker"
        onPress={onPress}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        style={({ pressed }) => [
            styles.root, hovered && styles.hovered, pressed && styles.pressed,
            focusVisible && styles.focusVisible, style
        ]}
    >
        <FixedPageColumn>
            <View style={styles.heading}>
                <AppText variant="section" style={styles.title}>Food log</AppText>
                {entries.length > 0 && <AppText style={styles.foodCount}>{foodCount}</AppText>}
                <View accessibilityElementsHidden aria-hidden>
                    <Ionicons name="expand-outline" size={20} color={theme.colors.primary} />
                </View>
            </View>
            {entries.length > 0 ? <View testID="food-preview-body">
                {meals.map((meal) => <View key={meal.meal} testID={`food-preview-meal-${meal.meal}`} style={styles.meal}>
                    <AppText style={styles.mealName}>{formatMealPeriod(meal.meal)}</AppText>
                    <AppText style={meal.entryCount ? styles.calories : styles.noEntries}>
                        {meal.entryCount ? formatCalories(meal.calories) : 'No entries'}
                    </AppText>
                </View>)}
            </View> : <View style={styles.empty}>
                <AppText style={styles.emptyTitle}>No food logged yet</AppText>
                <AppText variant="muted">Add food to start this day's log.</AppText>
            </View>}
        </FixedPageColumn>
    </Pressable>;

    if (expanded) return content;
    return <ScrollView
        testID="today-food-scroll"
        style={styles.scroller}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        bounces={false}
        overScrollMode="never"
    >
        {content}
    </ScrollView>;
}

function createStyles(theme: AppTheme) {
    return StyleSheet.create({
        scroller: { flex: 1, minHeight: 0 },
        scrollContent: { flexGrow: 1 },
        // Grow the hit target into spare page space while keeping all meal rows at their natural height.
        root: { flexGrow: 1, flexShrink: 0, flexBasis: 'auto', width: '100%', paddingTop: theme.spacing.md, paddingBottom: theme.spacing.sm },
        heading: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm, marginBottom: theme.spacing.sm },
        title: { flex: 1 },
        foodCount: { ...theme.typography.styles.label, fontWeight: '400', color: theme.colors.onSurfaceVariant },
        // The shared 48px row rhythm leaves totals easy to scan without stretching rows on tall screens.
        meal: { minHeight: theme.interaction.minimumTouchTarget, flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md, paddingVertical: theme.spacing.sm },
        mealName: { flex: 1 },
        calories: { flexShrink: 0, fontWeight: '600', fontVariant: ['tabular-nums'] },
        noEntries: { ...theme.typography.styles.label, flexShrink: 0, fontWeight: '400', color: theme.colors.onSurfaceVariant },
        empty: { paddingVertical: theme.spacing.lg, gap: theme.spacing.xs },
        emptyTitle: { fontWeight: '500' },
        hovered: { backgroundColor: theme.colors.surfaceHovered },
        pressed: { backgroundColor: theme.colors.surfacePressed },
        focusVisible: { outlineWidth: theme.interaction.focusRingWidth, outlineStyle: 'solid', outlineColor: theme.colors.focusRing }
    });
}
