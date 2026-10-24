/** @file Regression coverage for Recipe Ingredient Editor: RecipeIngredientSelector. */

import React, { useState } from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MyFoodSummary } from '@calibrate/api-client';
import type { RecipeIngredientDraft } from '../utils/myFoodEditing';
import {
    RECIPE_INGREDIENT_PAGE_SIZE,
    RecipeIngredientSelector
} from './RecipeIngredientSelector';
import { RecipeIngredientEditor } from './RecipeIngredientEditor';

jest.mock('@expo/vector-icons/Ionicons', () => () => null);

const mockApi = {
    getMyFoodsLibrary: jest.fn()
};

jest.mock('../auth/AuthContext', () => ({
    useAuth: () => ({ api: mockApi })
}));

function savedFood(id: number, name = `Saved food ${id}`, calories = 100): MyFoodSummary {
    return {
        id,
        type: 'FOOD',
        name,
        serving_size_quantity: 1,
        serving_unit_label: 'serving',
        calories_per_serving: calories,
        is_pinned: false
    };
}

function renderWithQueryClient(node: React.ReactElement) {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false, gcTime: 0 },
            mutations: { retry: false, gcTime: 0 }
        }
    });
    return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
}

describe('RecipeIngredientSelector', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    afterEach(cleanup);

    it('starts with a compact page and can add a saved ingredient from a later page', async () => {
        const firstPage = Array.from({ length: RECIPE_INGREDIENT_PAGE_SIZE }, (_, index) => savedFood(index + 1));
        const deepFood = savedFood(37, 'Deep pantry lentils');
        mockApi.getMyFoodsLibrary.mockImplementation(({ cursor }: { cursor?: string }) => Promise.resolve(
            cursor === 'page-2'
                ? { items: [deepFood], next_cursor: null }
                : { items: firstPage, next_cursor: 'page-2' }
        ));
        const onAddIngredient = jest.fn();
        const screen = renderWithQueryClient(
            <RecipeIngredientSelector enabled onAddIngredient={onAddIngredient} />
        );

        await waitFor(() => expect(screen.getByText(`Saved food ${RECIPE_INGREDIENT_PAGE_SIZE}`)).toBeTruthy());
        expect(screen.queryByText('Deep pantry lentils')).toBeNull();
        fireEvent.press(screen.getByRole('button', { name: 'Load more saved foods' }));
        await waitFor(() => expect(screen.getByText('Deep pantry lentils')).toBeTruthy());
        fireEvent.press(screen.getByRole('button', { name: 'Add Deep pantry lentils to recipe' }));

        expect(mockApi.getMyFoodsLibrary).toHaveBeenLastCalledWith(expect.objectContaining({
            type: 'FOOD',
            cursor: 'page-2',
            limit: RECIPE_INGREDIENT_PAGE_SIZE
        }));
        expect(onAddIngredient).toHaveBeenCalledWith(deepFood);
    });

    it('debounces server search and reports a query-specific empty result', async () => {
        mockApi.getMyFoodsLibrary.mockImplementation(({ q }: { q?: string }) => Promise.resolve({
            items: q === 'unfindable' ? [] : [savedFood(1)],
            next_cursor: null
        }));
        const screen = renderWithQueryClient(
            <RecipeIngredientSelector enabled onAddIngredient={jest.fn()} />
        );
        await waitFor(() => expect(screen.getByText('Saved food 1')).toBeTruthy());

        fireEvent.changeText(screen.getByLabelText('Search saved foods'), ' unfindable ');

        await waitFor(() => expect(mockApi.getMyFoodsLibrary).toHaveBeenCalledWith(expect.objectContaining({
            q: 'unfindable',
            type: 'FOOD'
        })));
        await waitFor(() => expect(screen.getByText('No saved foods match this search.')).toBeTruthy());
    });
});

describe('RecipeIngredientEditor', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockApi.getMyFoodsLibrary.mockResolvedValue({ items: [], next_cursor: null });
    });

    afterEach(cleanup);

    it('merges a paged authoritative summary and preserves serving and removal controls', async () => {
        const authoritative = savedFood(44, 'Renamed authoritative oats', 180);
        mockApi.getMyFoodsLibrary.mockResolvedValue({ items: [authoritative], next_cursor: null });
        const initial: RecipeIngredientDraft[] = [{
            key: 'existing-9',
            source: 'MY_FOOD',
            myFood: savedFood(44, 'Snapshot oats', 150),
            servings: 1
        }];
        const Harness = () => {
            const [ingredients, setIngredients] = useState(initial);
            return <RecipeIngredientEditor enabled ingredients={ingredients} onChange={setIngredients} />;
        };
        const screen = renderWithQueryClient(<Harness />);

        await waitFor(() => expect(screen.getAllByText('Renamed authoritative oats')).toHaveLength(2));
        expect(screen.getByText('180 kcal')).toBeTruthy();
        fireEvent.press(screen.getByRole('button', { name: 'Increase Renamed authoritative oats servings' }));
        expect(screen.getByText('1.25x')).toBeTruthy();
        expect(screen.getByText('225 kcal')).toBeTruthy();
        fireEvent.press(screen.getByRole('button', { name: 'Remove Renamed authoritative oats' }));
        expect(screen.queryByRole('button', { name: 'Remove Renamed authoritative oats' })).toBeNull();
        expect(screen.getAllByText('Renamed authoritative oats')).toHaveLength(1);
    });

    it('applies serving deltas without snapping precise legacy quantities to a new grid', async () => {
        const legacyFood = savedFood(45, 'Legacy precise oats', 160);
        const initial: RecipeIngredientDraft[] = [{
            key: 'existing-10',
            source: 'MY_FOOD',
            myFood: legacyFood,
            servings: 1.1
        }];
        const Harness = () => {
            const [ingredients, setIngredients] = useState(initial);
            return <RecipeIngredientEditor enabled ingredients={ingredients} onChange={setIngredients} />;
        };
        const screen = renderWithQueryClient(<Harness />);

        fireEvent.press(screen.getByRole('button', { name: 'Increase Legacy precise oats servings' }));
        expect(screen.getByText('1.35x')).toBeTruthy();
        fireEvent.press(screen.getByRole('button', { name: 'Decrease Legacy precise oats servings' }));
        expect(screen.getByText('1.1x')).toBeTruthy();
    });

    it('never increases a legacy quantity that is below the current decrement step', () => {
        const tinyFood = savedFood(46, 'Tiny precise amount');
        const initial: RecipeIngredientDraft[] = [{
            key: 'existing-11',
            source: 'MY_FOOD',
            myFood: tinyFood,
            servings: 0.125
        }];
        const Harness = () => {
            const [ingredients, setIngredients] = useState(initial);
            return <RecipeIngredientEditor enabled ingredients={ingredients} onChange={setIngredients} />;
        };
        const screen = renderWithQueryClient(<Harness />);

        const decrease = screen.getByRole('button', { name: 'Decrease Tiny precise amount servings' });
        expect(decrease.props.accessibilityState.disabled).toBe(true);
        expect(screen.getByText('0.125x')).toBeTruthy();
    });
});
