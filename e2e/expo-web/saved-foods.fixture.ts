/** @file saved foods: Stateful deterministic Saved Foods API used only by the focused Launch 13 lifecycle spec. */

import type { Page, Route } from '@playwright/test';

export const DEEP_SAVED_FOOD_NAME = 'Saved pantry 25';

type StubMyFood = {
  id: number;
  type: 'FOOD' | 'RECIPE';
  name: string;
  serving_size_quantity: number;
  serving_unit_label: string;
  calories_per_serving: number;
  is_pinned: boolean;
  recipe_total_calories?: number | null;
  yield_servings?: number | null;
};

type StubRecipeIngredient = {
  id: number;
  recipe_id: number;
  sort_order: number;
  source: 'MY_FOOD';
  name_snapshot: string;
  calories_total_snapshot: number;
  source_my_food_id: number | null;
  quantity_servings: number;
  serving_size_quantity_snapshot: number;
  serving_unit_label_snapshot: string;
  calories_per_serving_snapshot: number;
  external_source: null;
  external_id: null;
  brand_snapshot: null;
  locale_snapshot: null;
  barcode_snapshot: null;
  measure_label_snapshot: null;
  grams_per_measure_snapshot: null;
  measure_quantity_snapshot: null;
  grams_total_snapshot: null;
};

type RecipeIngredientPayload = {
  source: 'MY_FOOD';
  my_food_id: number;
  quantity_servings: number;
  sort_order?: number;
};

type RecipePayload = {
  name: string;
  serving_size_quantity: number;
  serving_unit_label: string;
  yield_servings: number;
  ingredients: RecipeIngredientPayload[];
};

function fulfillJson(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function stableLibrarySort(left: StubMyFood, right: StubMyFood) {
  if (left.is_pinned !== right.is_pinned) return left.is_pinned ? -1 : 1;
  const byName = left.name.toLocaleLowerCase().localeCompare(right.name.toLocaleLowerCase());
  return byName || left.id - right.id;
}

/** Stateful deterministic Saved Foods API used only by the focused Launch 13 lifecycle spec. */
export async function installSavedFoodsFixture(page: Page) {
  let nextFoodId = 1_000;
  let nextIngredientId = 2_000;
  const items: StubMyFood[] = Array.from({ length: 30 }, (_, index) => ({
    id: index + 1,
    type: 'FOOD',
    name: `Saved pantry ${String(index + 1).padStart(2, '0')}`,
    serving_size_quantity: 1,
    serving_unit_label: 'serving',
    calories_per_serving: 100 + index,
    is_pinned: false,
  }));
  const recipeIngredients = new Map<number, StubRecipeIngredient[]>();
  let nextFoodLogId = 3_000;
  const foodLogs = [{
    id: nextFoodLogId++,
    meal_period: 'BREAKFAST',
    name: 'Fixture breakfast',
    calories: 360,
    servings_consumed: 1,
  }];

  function findItem(id: number) {
    return items.find((item) => item.id === id);
  }

  function snapshotIngredients(recipeId: number, ingredients: RecipeIngredientPayload[]) {
    return ingredients.map((ingredient, index) => {
      const source = findItem(ingredient.my_food_id);
      if (!source || source.type !== 'FOOD') throw new Error(`Missing fixture ingredient ${ingredient.my_food_id}`);
      return {
        id: nextIngredientId++,
        recipe_id: recipeId,
        sort_order: ingredient.sort_order ?? index + 1,
        source: 'MY_FOOD' as const,
        name_snapshot: source.name,
        calories_total_snapshot: source.calories_per_serving * ingredient.quantity_servings,
        source_my_food_id: source.id,
        quantity_servings: ingredient.quantity_servings,
        serving_size_quantity_snapshot: source.serving_size_quantity,
        serving_unit_label_snapshot: source.serving_unit_label,
        calories_per_serving_snapshot: source.calories_per_serving,
        external_source: null,
        external_id: null,
        brand_snapshot: null,
        locale_snapshot: null,
        barcode_snapshot: null,
        measure_label_snapshot: null,
        grams_per_measure_snapshot: null,
        measure_quantity_snapshot: null,
        grams_total_snapshot: null,
      };
    });
  }

  function updateRecipe(item: StubMyFood, payload: RecipePayload) {
    const ingredients = snapshotIngredients(item.id, payload.ingredients);
    const totalCalories = ingredients.reduce((sum, ingredient) => sum + ingredient.calories_total_snapshot, 0);
    Object.assign(item, {
      name: payload.name,
      serving_size_quantity: payload.serving_size_quantity,
      serving_unit_label: payload.serving_unit_label,
      yield_servings: payload.yield_servings,
      recipe_total_calories: totalCalories,
      calories_per_serving: totalCalories / payload.yield_servings,
    });
    recipeIngredients.set(item.id, ingredients);
  }

  await page.route('**/api/v1/my-foods**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const method = request.method();

    if (pathname === '/api/v1/my-foods/library' && method === 'GET') {
      const q = (url.searchParams.get('q') ?? '').trim().toLocaleLowerCase();
      const type = url.searchParams.get('type');
      const offset = Number(url.searchParams.get('cursor') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 24);
      const matching = [...items]
        .filter((item) => (!q || item.name.toLocaleLowerCase().includes(q)))
        .filter((item) => (!type || item.type === type))
        .sort(stableLibrarySort);
      const pageItems = matching.slice(offset, offset + limit);
      const nextOffset = offset + pageItems.length;
      return fulfillJson(route, {
        items: pageItems,
        next_cursor: nextOffset < matching.length ? String(nextOffset) : null,
      });
    }

    if (pathname === '/api/v1/my-foods' && method === 'GET') {
      return fulfillJson(route, [...items].sort(stableLibrarySort));
    }

    if (pathname === '/api/v1/my-foods/foods' && method === 'POST') {
      const payload = request.postDataJSON() as Omit<StubMyFood, 'id' | 'type' | 'is_pinned'>;
      const item: StubMyFood = { id: nextFoodId++, type: 'FOOD', is_pinned: false, ...payload };
      items.push(item);
      return fulfillJson(route, item, 201);
    }

    if (pathname === '/api/v1/my-foods/recipes' && method === 'POST') {
      const payload = request.postDataJSON() as RecipePayload;
      const item: StubMyFood = {
        id: nextFoodId++,
        type: 'RECIPE',
        name: payload.name,
        serving_size_quantity: payload.serving_size_quantity,
        serving_unit_label: payload.serving_unit_label,
        calories_per_serving: 0,
        is_pinned: false,
      };
      items.push(item);
      updateRecipe(item, payload);
      return fulfillJson(route, item, 201);
    }

    const pinMatch = /^\/api\/v1\/my-foods\/(\d+)\/pin$/.exec(pathname);
    if (pinMatch && method === 'PATCH') {
      const item = findItem(Number(pinMatch[1]));
      if (!item) return fulfillJson(route, { message: 'Saved food not found' }, 404);
      item.is_pinned = Boolean((request.postDataJSON() as { is_pinned: boolean }).is_pinned);
      return fulfillJson(route, item);
    }

    const itemMatch = /^\/api\/v1\/my-foods\/(\d+)$/.exec(pathname);
    if (!itemMatch) return route.fallback();
    const itemId = Number(itemMatch[1]);
    const item = findItem(itemId);
    if (!item) return fulfillJson(route, { message: 'Saved food not found' }, 404);

    if (method === 'GET') {
      return fulfillJson(route, {
        ...item,
        ...(item.type === 'RECIPE' ? { recipe_ingredients: recipeIngredients.get(item.id) ?? [] } : {}),
      });
    }
    if (method === 'PATCH') {
      const payload = request.postDataJSON() as Partial<StubMyFood> & Partial<RecipePayload>;
      if (item.type === 'RECIPE' && payload.ingredients) updateRecipe(item, payload as RecipePayload);
      else Object.assign(item, payload);
      return fulfillJson(route, item);
    }
    if (method === 'DELETE') {
      items.splice(items.indexOf(item), 1);
      if (item.type === 'FOOD') {
        for (const ingredients of recipeIngredients.values()) {
          for (const ingredient of ingredients) {
            if (ingredient.source_my_food_id === item.id) ingredient.source_my_food_id = null;
          }
        }
      }
      recipeIngredients.delete(item.id);
      return route.fulfill({ status: 204 });
    }

    return route.fallback();
  });

  await page.route('**/api/v1/food**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname !== '/api/v1/food') return route.fallback();
    if (request.method() === 'GET') return fulfillJson(route, foodLogs);
    if (request.method() !== 'POST') return route.fallback();

    const payload = request.postDataJSON() as {
      date: string;
      meal_period: string;
      my_food_id?: number;
      servings_consumed?: number;
      name?: string;
      calories?: number;
    };
    const source = payload.my_food_id ? findItem(payload.my_food_id) : undefined;
    const servings = payload.servings_consumed ?? 1;
    const entry = {
      ...payload,
      id: nextFoodLogId++,
      name: source?.name ?? payload.name ?? 'Quick entry',
      calories: source ? Math.round(source.calories_per_serving * servings) : payload.calories ?? 0,
      servings_consumed: servings,
      serving_size_quantity_snapshot: source?.serving_size_quantity ?? null,
      serving_unit_label_snapshot: source?.serving_unit_label ?? null,
      calories_per_serving_snapshot: source?.calories_per_serving ?? null,
    };
    foodLogs.push(entry);
    return fulfillJson(route, entry, 201);
  });
}
