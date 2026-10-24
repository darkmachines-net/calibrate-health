/** @file Regression coverage for my Food Form Validation: saved-food form error association. */

import {
    getRecipeNameError,
    getSavedFoodNameError,
    RECIPE_NAME_REQUIRED_ERROR,
    SAVED_FOOD_NAME_REQUIRED_ERROR
} from './myFoodFormValidation';

describe('saved-food form error association', () => {
    it('associates only the required-name error with the name field', () => {
        expect(getSavedFoodNameError(SAVED_FOOD_NAME_REQUIRED_ERROR)).toBe(SAVED_FOOD_NAME_REQUIRED_ERROR);
        expect(getSavedFoodNameError('Enter a valid serving, unit, and calorie value.')).toBeUndefined();
        expect(getRecipeNameError(RECIPE_NAME_REQUIRED_ERROR)).toBe(RECIPE_NAME_REQUIRED_ERROR);
        expect(getRecipeNameError('Add a valid serving, yield, and at least one ingredient.')).toBeUndefined();
    });
});
