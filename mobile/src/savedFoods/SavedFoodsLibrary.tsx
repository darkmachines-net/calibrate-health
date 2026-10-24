/** @file Saved Foods Library: Renders searchable, paginated saved foods with create, edit, pin, and scan entry points. */

import { useEffect, useMemo, useState } from 'react';
import { router } from 'expo-router';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { MyFoodSummary } from '@calibrate/api-client';
import { useAuth } from '../auth/AuthContext';
import { useServerSettings } from '../serverSettings/useServerSettings';
import { AppButton } from '../components/AppButton';
import { AppChip } from '../components/AppChip';
import { AppIconButton } from '../components/AppIconButton';
import { AppText } from '../components/AppText';
import { AsyncStateBoundary, useAsyncResourceState, useOnlineStatus } from '../components/AsyncStateBoundary';
import { SkeletonBlock } from '../components/SkeletonBlock';
import { TextField } from '../components/TextField';
import { getSafeActionErrorMessage } from '../errors/presentation';
import { formatCalories } from '../utils/format';
import { spacing, useAppTheme, type AppTheme } from '../theme';
import { useClientQueryFailureDiagnostic } from '../diagnostics/operationDiagnostics';
import {
    getSavedFoodsLibraryQueryKey,
    SAVED_FOODS_LIBRARY_QUERY_KEY,
    SAVED_FOODS_LIBRARY_PAGE_SIZE,
    type SavedFoodsFilter
} from './queryKeys';

export { getSavedFoodsLibraryQueryKey, SAVED_FOODS_LIBRARY_QUERY_KEY } from './queryKeys';

type SavedFoodsLibraryProps = {
    onCreateFood: () => void;
    onCreateRecipe: () => void;
    onEdit: (item: MyFoodSummary) => void;
};

const SEARCH_DEBOUNCE_MS = 350;
const NARROW_LIBRARY_BREAKPOINT = 520; // Stacks primary actions on small phone viewports.
const FILTER_OPTIONS: Array<{ value: SavedFoodsFilter; label: string }> = [
    { value: 'ALL', label: 'All' },
    { value: 'FOOD', label: 'Foods' },
    { value: 'RECIPE', label: 'Recipes' }
];

/** Renders searchable, paginated saved foods with create, edit, pin, and scan entry points. */
export function SavedFoodsLibrary({
    onCreateFood,
    onCreateRecipe,
    onEdit
}: SavedFoodsLibraryProps) {
    const theme = useAppTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    const { width, fontScale } = useWindowDimensions();
    const isNarrow = width < NARROW_LIBRARY_BREAKPOINT;
    const stackCreateActions = fontScale >= 1.3;
    const { api } = useAuth();
    const { nutritionLabelScanning } = useServerSettings();
    const queryClient = useQueryClient();
    const isOnline = useOnlineStatus();
    const [searchText, setSearchText] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const [filter, setFilter] = useState<SavedFoodsFilter>('ALL');
    const normalizedSearch = searchText.trim();

    useEffect(() => {
        const timeout = setTimeout(() => setDebouncedSearch(normalizedSearch), SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timeout);
    }, [normalizedSearch]);

    const libraryQuery = useInfiniteQuery({
        queryKey: getSavedFoodsLibraryQueryKey(debouncedSearch, filter),
        queryFn: ({ pageParam }) => api.getMyFoodsLibrary({
            q: debouncedSearch || undefined,
            type: filter === 'ALL' ? undefined : filter,
            cursor: pageParam,
            limit: SAVED_FOODS_LIBRARY_PAGE_SIZE
        }),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined
    });
    const items = libraryQuery.data?.pages.flatMap((page) => page.items) ?? [];
    const libraryState = useAsyncResourceState(libraryQuery, (data) =>
        data.pages.every((page) => page.items.length === 0)
    );
    useClientQueryFailureDiagnostic({
        operation: 'saved_foods_load',
        isError: libraryQuery.isError || libraryQuery.isFetchNextPageError,
        error: libraryQuery.error,
        errorUpdatedAt: libraryQuery.errorUpdatedAt
    });
    const isWaitingForSearch = normalizedSearch !== debouncedSearch;

    const setPinned = useMutation({
        mutationFn: (item: MyFoodSummary) => api.setMyFoodPinned(item.id, !item.is_pinned),
        onSuccess: async () => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: SAVED_FOODS_LIBRARY_QUERY_KEY }),
                queryClient.invalidateQueries({ queryKey: ['mobile-my-foods'] })
            ]);
        }
    });

    const header = (
        <View style={[styles.header, isNarrow && styles.headerNarrow]}>
            <View style={styles.headerCopy}>
                <AppText variant="muted">Keep reusable foods and recipes easy to find.</AppText>
            </View>
            <View style={[styles.createActions, isNarrow && styles.createActionsNarrow]}>
                <View style={[styles.creationPair, isNarrow && styles.creationPairNarrow, stackCreateActions && styles.creationPairStacked]}>
                    <AppButton
                        title="Create food"
                        variant="secondary"
                        leftIcon={!isNarrow ? <Ionicons name="add" size={18} color={theme.colors.onSurface} /> : undefined}
                        onPress={onCreateFood}
                        style={isNarrow ? styles.creationAction : undefined}
                    />
                    <AppButton
                        title="Create recipe"
                        leftIcon={!isNarrow ? <Ionicons name="restaurant-outline" size={18} color={theme.colors.onPrimary} /> : undefined}
                        onPress={onCreateRecipe}
                        style={isNarrow ? styles.creationAction : undefined}
                    />
                </View>
                {nutritionLabelScanning && <AppButton title="Scan label" variant="ghost" onPress={() => router.push('/nutrition-label')} style={isNarrow ? styles.narrowAction : undefined} />}
            </View>
        </View>
    );

    function renderEmpty() {
        if (isWaitingForSearch) {
            return (
                <View testID="saved-foods-searching" style={styles.content}>
                    {header}
                    {renderBrowseControls()}
                    <AppText variant="muted">Searching saved foods...</AppText>
                </View>
            );
        }
        let message = 'No saved foods yet. Create a food or recipe to reuse it when logging.';
        if (debouncedSearch) message = `No saved foods match "${debouncedSearch}".`;
        else if (filter === 'FOOD') message = 'No saved foods in this filter yet.';
        else if (filter === 'RECIPE') message = 'No saved recipes in this filter yet.';
        return (
            <View testID="saved-foods-empty" style={styles.content}>
                {header}
                {renderBrowseControls()}
                <AppText variant="muted">{message}</AppText>
            </View>
        );
    }

    function renderBrowseControls() {
        return (
            <View style={styles.browseControls}>
                <TextField
                    label="Search saved foods"
                    value={searchText}
                    onChangeText={setSearchText}
                    placeholder="Search by name"
                    returnKeyType="search"
                />
                <View accessibilityRole="radiogroup" style={styles.filters}>
                    {FILTER_OPTIONS.map((option) => (
                        <AppChip
                            key={option.value}
                            label={option.label}
                            accessibilityRole="radio"
                            selected={filter === option.value}
                            onPress={() => setFilter(option.value)}
                        />
                    ))}
                </View>
                {isWaitingForSearch && items.length > 0 && (
                    <AppText accessibilityLiveRegion="polite" variant="caption">Updating results...</AppText>
                )}
            </View>
        );
    }

    return (
        <AsyncStateBoundary
            state={libraryState}
            resourceLabel="saved foods"
            loading={(
                <View testID="saved-foods-loading" style={styles.content}>
                    {header}
                    <SkeletonBlock height={48} />
                    {[0, 1, 2].map((row) => <SkeletonBlock key={row} height={64} />)}
                </View>
            )}
            empty={renderEmpty()}
            onRetry={isOnline ? () => libraryQuery.refetch() : undefined}
            retrying={libraryQuery.isFetching}
        >
            <View testID="saved-foods-list" style={styles.content}>
                {header}
                {renderBrowseControls()}
                <AppText variant="caption">
                    {libraryQuery.hasNextPage
                        ? `Showing ${items.length} saved items so far`
                        : `${items.length} saved ${items.length === 1 ? 'item' : 'items'}`}
                </AppText>
                <View style={styles.libraryList}>
                    {items.map((item) => (
                        <View key={item.id} style={[styles.libraryRow, isNarrow && styles.libraryRowNarrow]}>
                            <View style={styles.libraryText}>
                                <View style={styles.itemTitleRow}>
                                    <AppText variant="body" numberOfLines={2}>{item.name}</AppText>
                                    {item.is_pinned && <Ionicons name="star" size={16} color={theme.colors.primary} />}
                                </View>
                                <AppText variant="caption" numberOfLines={2}>
                                    {item.type === 'RECIPE' ? 'Recipe' : 'Food'} | {formatCalories(item.calories_per_serving)} per {item.serving_size_quantity} {item.serving_unit_label}
                                </AppText>
                            </View>
                            <View style={[styles.libraryActions, isNarrow && styles.libraryActionsNarrow]}>
                                <AppIconButton
                                    icon="create-outline"
                                    variant="ghost"
                                    accessibilityLabel={`Edit ${item.name}`}
                                    iconColor={theme.colors.onSurface}
                                    onPress={() => onEdit(item)}
                                />
                                <AppIconButton
                                    icon={item.is_pinned ? 'star' : 'star-outline'}
                                    variant="ghost"
                                    accessibilityLabel={`${item.is_pinned ? 'Unpin' : 'Pin'} ${item.name}`}
                                    busy={setPinned.isPending && setPinned.variables?.id === item.id}
                                    iconColor={item.is_pinned ? theme.colors.primary : theme.colors.onSurfaceVariant}
                                    onPress={() => setPinned.mutate(item)}
                                />
                            </View>
                        </View>
                    ))}
                </View>
                {setPinned.error && (
                    <AppText accessibilityRole="alert" style={styles.error}>
                        {getSafeActionErrorMessage(setPinned.error, 'Unable to update this saved food.')}
                    </AppText>
                )}
                {libraryQuery.hasNextPage && (
                    <AppButton
                        title="Load more"
                        variant="secondary"
                        busy={libraryQuery.isFetchingNextPage}
                        busyLabel="Loading more..."
                        disabled={!isOnline}
                        onPress={() => void libraryQuery.fetchNextPage()}
                    />
                )}
            </View>
        </AsyncStateBoundary>
    );
}

function createStyles(theme: AppTheme) {
    return StyleSheet.create({
        content: {
            width: '100%',
            gap: spacing.md
        },
        header: {
            flexDirection: 'row',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: spacing.lg
        },
        headerNarrow: {
            flexDirection: 'column'
        },
        headerCopy: {
            flex: 1,
            minWidth: 0,
            gap: spacing.xs
        },
        createActions: {
            flexDirection: 'row',
            flexWrap: 'wrap',
            justifyContent: 'flex-end',
            gap: spacing.sm
        },
        createActionsNarrow: {
            width: '100%',
            flexDirection: 'column',
            justifyContent: 'flex-start'
        },
        narrowAction: {
            width: '100%'
        },
        creationPair: {
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: spacing.sm
        },
        creationPairNarrow: {
            width: '100%'
        },
        creationPairStacked: {
            flexDirection: 'column'
        },
        creationAction: {
            flexGrow: 1
        },
        browseControls: {
            gap: spacing.sm
        },
        filters: {
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: spacing.sm
        },
        libraryList: {
            gap: spacing.sm
        },
        libraryRow: {
            minHeight: 64,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: spacing.md,
            borderTopColor: theme.colors.outlineVariant,
            borderTopWidth: StyleSheet.hairlineWidth,
            paddingTop: spacing.md
        },
        libraryRowNarrow: {
            alignItems: 'flex-start'
        },
        libraryText: {
            flex: 1,
            minWidth: 0,
            gap: spacing.xs
        },
        itemTitleRow: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing.xs,
            minWidth: 0
        },
        libraryActions: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing.sm
        },
        libraryActionsNarrow: {
            gap: spacing.xs
        },
        error: {
            color: theme.colors.danger
        }
    });
}
