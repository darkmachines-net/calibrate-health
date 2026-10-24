/** @file Regression coverage for Saved Foods Library: SavedFoodsLibrary. */

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MyFoodSummary } from '@calibrate/api-client';
import {
    getSavedFoodsLibraryQueryKey,
    SavedFoodsLibrary
} from './SavedFoodsLibrary';
import { spacing } from '../theme';

jest.mock('@expo/vector-icons/Ionicons', () => () => null);
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

const mockApi = {
    getMyFoodsLibrary: jest.fn(),
    setMyFoodPinned: jest.fn()
};

jest.mock('../auth/AuthContext', () => ({
    useAuth: () => ({ api: mockApi })
}));

function savedFood(id: number, overrides: Partial<MyFoodSummary> = {}): MyFoodSummary {
    return {
        id,
        type: 'FOOD',
        name: `Saved food ${id}`,
        serving_size_quantity: 1,
        serving_unit_label: 'serving',
        calories_per_serving: 120,
        is_pinned: false,
        ...overrides
    };
}

function renderLibrary(seed?: (queryClient: QueryClient) => void) {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false, gcTime: 0 },
            mutations: { retry: false, gcTime: 0 }
        }
    });
    seed?.(queryClient);
    const props = {
        onCreateFood: jest.fn(),
        onCreateRecipe: jest.fn(),
        onEdit: jest.fn()
    };
    const screen = render(
        <QueryClientProvider client={queryClient}>
            <SavedFoodsLibrary {...props} />
        </QueryClientProvider>
    );
    return { ...screen, props, queryClient };
}

describe('SavedFoodsLibrary', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        onlineManager.setOnline(true);
        mockApi.getMyFoodsLibrary.mockResolvedValue({ items: [], next_cursor: null });
        mockApi.setMyFoodPinned.mockImplementation((_id: number, isPinned: boolean) =>
            Promise.resolve(savedFood(1, { is_pinned: isPinned }))
        );
    });

    afterEach(() => {
        cleanup();
        onlineManager.setOnline(true);
    });

    it('distinguishes initial loading from a verified empty library and exposes explicit create actions', async () => {
        const screen = renderLibrary();

        const loadingStyle = StyleSheet.flatten(screen.getByTestId('saved-foods-loading').props.style);
        expect(loadingStyle).toEqual(expect.objectContaining({ width: '100%', gap: spacing.md }));
        expect(loadingStyle).not.toHaveProperty('padding');
        expect(loadingStyle).not.toHaveProperty('borderRadius');

        await waitFor(() => {
            const emptyStyle = StyleSheet.flatten(screen.getByTestId('saved-foods-empty').props.style);
            expect(emptyStyle).toEqual(expect.objectContaining({ width: '100%', gap: spacing.md }));
            expect(emptyStyle).not.toHaveProperty('padding');
            expect(emptyStyle).not.toHaveProperty('borderRadius');
        });
        expect(screen.getByText('No saved foods yet. Create a food or recipe to reuse it when logging.')).toBeTruthy();

        fireEvent.press(screen.getByRole('button', { name: 'Create food' }));
        fireEvent.press(screen.getByRole('button', { name: 'Create recipe' }));
        expect(screen.props.onCreateFood).toHaveBeenCalledTimes(1);
        expect(screen.props.onCreateRecipe).toHaveBeenCalledTimes(1);
    });

    it('shows an error instead of empty copy when an uncached request fails', async () => {
        mockApi.getMyFoodsLibrary.mockRejectedValue(new Error('request failed'));
        const screen = renderLibrary();

        await waitFor(() => expect(screen.getByTestId('async-state-error')).toBeTruthy());
        expect(screen.queryByTestId('saved-foods-empty')).toBeNull();
        expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    });

    it('keeps cached content visible and labels it stale while offline', async () => {
        const cached = savedFood(7, { name: 'Cached oats' });
        onlineManager.setOnline(false);
        const screen = renderLibrary((queryClient) => {
            queryClient.setQueryData(getSavedFoodsLibraryQueryKey('', 'ALL'), {
                pages: [{ items: [cached], next_cursor: null }],
                pageParams: [undefined]
            });
        });

        await waitFor(() => expect(screen.getByText('Offline - showing saved information')).toBeTruthy());
        expect(screen.getByText('Cached oats')).toBeTruthy();
        expect(screen.queryByTestId('saved-foods-empty')).toBeNull();
    });

    it('debounces server search, applies type filters, and appends cursor pages', async () => {
        const first = savedFood(1, { name: 'Apple' });
        const second = savedFood(2, { name: 'Oats' });
        mockApi.getMyFoodsLibrary.mockImplementation((options: {
            q?: string;
            type?: MyFoodSummary['type'];
            cursor?: string;
        }) => {
            if (options.cursor === 'page-2') return Promise.resolve({ items: [second], next_cursor: null });
            if (options.q === 'oats') return Promise.resolve({ items: [second], next_cursor: null });
            if (options.type === 'RECIPE') {
                return Promise.resolve({
                    items: [savedFood(3, { type: 'RECIPE', name: 'Soup recipe' })],
                    next_cursor: null
                });
            }
            return Promise.resolve({ items: [first], next_cursor: 'page-2' });
        });
        const screen = renderLibrary();

        await waitFor(() => expect(screen.getByText('Apple')).toBeTruthy());
        fireEvent.press(screen.getByRole('button', { name: 'Load more' }));
        await waitFor(() => expect(screen.getByText('Oats')).toBeTruthy());
        expect(mockApi.getMyFoodsLibrary).toHaveBeenCalledWith(expect.objectContaining({
            cursor: 'page-2',
            limit: 24
        }));

        fireEvent.press(screen.getByRole('radio', { name: 'Recipes' }));
        await waitFor(() => expect(screen.getByText('Soup recipe')).toBeTruthy());
        expect(mockApi.getMyFoodsLibrary).toHaveBeenCalledWith(expect.objectContaining({ type: 'RECIPE' }));

        const callsBeforeSearch = mockApi.getMyFoodsLibrary.mock.calls.length;
        fireEvent.changeText(screen.getByLabelText('Search saved foods'), '  oats  ');
        expect(mockApi.getMyFoodsLibrary).toHaveBeenCalledTimes(callsBeforeSearch);
        await waitFor(() => expect(mockApi.getMyFoodsLibrary).toHaveBeenCalledWith(expect.objectContaining({
            q: 'oats',
            type: 'RECIPE'
        })));
    });

    it('pins and edits an item with item-specific accessible actions', async () => {
        const item = savedFood(12, { name: 'Greek yogurt' });
        mockApi.getMyFoodsLibrary.mockResolvedValue({ items: [item], next_cursor: null });
        const screen = renderLibrary();

        await waitFor(() => expect(screen.getByText('Greek yogurt')).toBeTruthy());
        fireEvent.press(screen.getByRole('button', { name: 'Edit Greek yogurt' }));
        fireEvent.press(screen.getByRole('button', { name: 'Pin Greek yogurt' }));

        expect(screen.props.onEdit).toHaveBeenCalledWith(item);
        await waitFor(() => expect(mockApi.setMyFoodPinned).toHaveBeenCalledWith(12, true));
    });
});
