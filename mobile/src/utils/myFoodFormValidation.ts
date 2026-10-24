/** @file Saved-food form validation and field-specific error association. */

export const SAVED_FOOD_NAME_REQUIRED_ERROR = 'Enter a name for this saved food.';
export const RECIPE_NAME_REQUIRED_ERROR = 'Enter a recipe name.';

/** Only associate name-required failures with the name field; composite failures stay form-level. */
export function getSavedFoodNameError(error: string | null): string | undefined {
    return error === SAVED_FOOD_NAME_REQUIRED_ERROR ? error : undefined;
}

/** Associates only the recipe-name-required error with the name field. */
export function getRecipeNameError(error: string | null): string | undefined {
    return error === RECIPE_NAME_REQUIRED_ERROR ? error : undefined;
}
