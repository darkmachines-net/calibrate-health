/** @file my Food Editing: Restores editable live references and preserves orphan/external ingredient snapshots verbatim. */

import type { CreateRecipePayload, MyFoodDetail, MyFoodSummary } from '@calibrate/api-client';

export type RecipeIngredientDraft =
    | { key: string; source: 'MY_FOOD'; myFood: MyFoodSummary; servings: number }
    | {
          key: string;
          source: 'EXTERNAL';
          name: string;
          caloriesTotal: number;
          snapshot: Omit<Extract<CreateRecipePayload['ingredients'][number], { source: 'EXTERNAL' }>, 'source' | 'sort_order' | 'name' | 'calories_total'>;
      };

/** Restores editable live references and preserves orphan/external ingredient snapshots verbatim. */
export function hydrateRecipeIngredientDrafts(
    detail: MyFoodDetail,
    savedFoods: MyFoodSummary[]
): RecipeIngredientDraft[] {
    return (detail.recipe_ingredients ?? []).map((ingredient) => {
        const sourceFood = ingredient.source_my_food_id
            ? savedFoods.find(({ id }) => id === ingredient.source_my_food_id)
            : undefined;
        if (ingredient.source === 'MY_FOOD' && ingredient.source_my_food_id && ingredient.quantity_servings) {
            const snapshotFood: MyFoodSummary = sourceFood ?? {
                id: ingredient.source_my_food_id,
                type: 'FOOD',
                name: ingredient.name_snapshot,
                serving_size_quantity: ingredient.serving_size_quantity_snapshot ?? 1,
                serving_unit_label: ingredient.serving_unit_label_snapshot ?? 'serving',
                calories_per_serving: ingredient.calories_per_serving_snapshot
                    ?? ingredient.calories_total_snapshot / ingredient.quantity_servings,
                is_pinned: false
            };
            return {
                key: `existing-${ingredient.id}`,
                source: 'MY_FOOD' as const,
                myFood: snapshotFood,
                servings: ingredient.quantity_servings
            };
        }
        return {
            key: `existing-${ingredient.id}`,
            source: 'EXTERNAL' as const,
            name: ingredient.name_snapshot,
            caloriesTotal: ingredient.calories_total_snapshot,
            snapshot: {
                quantity_servings: ingredient.quantity_servings,
                serving_size_quantity: ingredient.serving_size_quantity_snapshot,
                serving_unit_label: ingredient.serving_unit_label_snapshot,
                calories_per_serving: ingredient.calories_per_serving_snapshot,
                external_source: ingredient.external_source,
                external_id: ingredient.external_id,
                brand: ingredient.brand_snapshot,
                locale: ingredient.locale_snapshot,
                barcode: ingredient.barcode_snapshot,
                measure_label: ingredient.measure_label_snapshot,
                grams_per_measure: ingredient.grams_per_measure_snapshot,
                measure_quantity: ingredient.measure_quantity_snapshot,
                grams_total: ingredient.grams_total_snapshot
            }
        };
    });
}

/** Serializes recipe drafts in display order while retaining saved-food references or external snapshots. */
export function serializeRecipeIngredientDrafts(
    drafts: RecipeIngredientDraft[]
): CreateRecipePayload['ingredients'] {
    return drafts.map((draft, index) => draft.source === 'MY_FOOD'
        ? {
              source: 'MY_FOOD',
              sort_order: index + 1,
              my_food_id: draft.myFood.id,
              quantity_servings: draft.servings
          }
        : {
              source: 'EXTERNAL',
              sort_order: index + 1,
              name: draft.name,
              calories_total: draft.caloriesTotal,
              ...draft.snapshot
          }
    );
}
