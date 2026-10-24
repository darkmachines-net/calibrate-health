/** @file types: Shared food data provider types used by provider implementations and routes. */

/**
 * Shared food data provider types used by provider implementations and routes.
 */
export type FoodDataSource = 'fatsecret' | 'usda' | 'openFoodFacts';

export interface Nutrients {
    calories: number;
    protein?: number;
    fat?: number;
    carbs?: number;
}

export interface FoodMeasure {
    label: string;
    gramWeight?: number;
    quantity?: number;
    unit?: string;
}

export interface NutrientsForQuantity {
    grams: number;
    nutrients: Nutrients;
    note?: string;
}

export interface NormalizedFoodItem {
    id: string;
    source: FoodDataSource;
    description: string;
    brand?: string;
    barcode?: string;
    locale?: string;
    availableMeasures: FoodMeasure[];
    nutrientsPer100g?: Nutrients;
    nutrientsForRequest?: NutrientsForQuantity;
}

export interface FoodSearchRequest {
    query?: string;
    barcode?: string;
    page?: number;
    pageSize?: number;
    quantityInGrams?: number;
    includeIncomplete?: boolean;
    languageCode?: string;
}

export interface FoodSearchResult {
    items: NormalizedFoodItem[];
}

export interface FoodDataProvider {
    name: FoodDataSource;
    supportsBarcodeLookup: boolean;
    /** Return normalized foods for one provider/page while preserving serving and provider attribution metadata. */
    searchFoods(request: FoodSearchRequest): Promise<FoodSearchResult>;
}
