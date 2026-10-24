/** @file USDA FoodData Central search and serving normalization with configured API credentials. */

import { FoodDataProvider, FoodMeasure, FoodSearchRequest, FoodSearchResult, NormalizedFoodItem, Nutrients } from './types';
import { parseNumber, round, scaleNutrients } from './utils';
import {
    buildFoodSearchQuery,
    buildProductTokenGroups,
    countTokenMatches,
    normalizeFoodSearchText,
    scoreProductTokenGroups,
    scoreTokenMatches,
    tokenizeFoodSearchQuery
} from './searchRanking';

/**
 * USDA FoodData Central provider implementation with local ranking.
 */
type FoodNutrient = {
    nutrientId?: number;
    nutrientName?: string;
    nutrientNumber?: string;
    unitName?: string;
    amount?: number;
    value?: number;
};

type FoodPortion = {
    modifier?: string;
    measureUnit?: { name?: string };
    portionDescription?: string;
    gramWeight?: number;
};

type LabelNutrients = {
    calories?: { value?: number };
    protein?: { value?: number };
    fat?: { value?: number };
    carbohydrates?: { value?: number };
};

type UsdaFood = {
    fdcId: number;
    description?: string;
    brandOwner?: string;
    brandName?: string;
    gtinUpc?: string;
    dataType?: string;
    householdServingFullText?: string;
    servingSize?: number;
    servingSizeUnit?: string;
    labelNutrients?: LabelNutrients;
    foodNutrients?: FoodNutrient[];
    foodPortions?: FoodPortion[];
};

type UsdaFoodsSearchRequestBody = {
    query: string;
    pageSize: number;
    pageNumber: number;
    dataType: string[];
    requireAllWords?: boolean;
    brandOwner?: string;
};

type UsdaFoodsSearchResponse = {
    foods?: UsdaFood[];
};

type UsdaQueryTokens = {
    normalizedQuery: string;
    normalizedBrandQuery?: string;
    normalizedProductQuery: string;
    rawBrandOwnerQuery?: string;
    brandTokens: string[];
    productTokens: string[];
};

const USDA_DEFAULT_DATA_TYPES = ['Branded', 'Foundation', 'SR Legacy', 'Survey (FNDDS)'];
const USDA_BRANDED_DATA_TYPES = ['Branded'];
// Fetch extra candidates so local relevance ranking can surface strong matches even when the upstream scoring is noisy.
const USDA_MAX_UPSTREAM_PAGE_SIZE = 200;

/**
 * Food data provider backed by USDA FoodData Central search endpoints.
 */
class UsdaFoodDataProvider implements FoodDataProvider {
    public name = 'usda' as const;
    public supportsBarcodeLookup = true;
    private apiKey: string;
    private baseUrl = 'https://api.nal.usda.gov/fdc/v1';

    /**
     * Construct a USDA FoodData Central provider instance for the supplied API key.
     */
    constructor(apiKey: string) {
        this.apiKey = apiKey;
    }

    /** Normalize USDA barcode or paginated text results; empty/invalid query input yields no items. */
    async searchFoods(request: FoodSearchRequest): Promise<FoodSearchResult> {
        const rawQuery = request.barcode || request.query;
        const trimmedQuery = rawQuery?.trim();
        if (!trimmedQuery) {
            return { items: [] };
        }

        const pageSize = Math.min(request.pageSize ?? 10, 50);
        const pageNumber = request.page ?? 1;

        if (request.barcode) {
            const normalizedBarcode = this.normalizeBarcodeValue(trimmedQuery);
            if (!normalizedBarcode) {
                return { items: [] };
            }

            const data = await this.executeSearch({
                query: normalizedBarcode,
                pageSize: USDA_MAX_UPSTREAM_PAGE_SIZE,
                pageNumber,
                dataType: USDA_DEFAULT_DATA_TYPES
            });

            const items = this.normalizeFoods(data.foods, request);
            const exactMatches = items.filter(
                (item) => this.normalizeBarcodeValue(item.barcode || '') === normalizedBarcode
            );

            return { items: (exactMatches.length > 0 ? exactMatches : items).slice(0, pageSize) };
        }

        const queryTokens = this.splitQueryTokens(trimmedQuery);
        const upstreamPageSize = this.resolveUpstreamPageSize(pageSize, queryTokens);
        const requireAllWords = this.shouldRequireAllWords(queryTokens.productTokens);

        const brandScoped = queryTokens.brandTokens.length > 0;
        const hasExplicitProductTerms = queryTokens.productTokens.length > 0;

        const upstreamQuery = brandScoped && hasExplicitProductTerms
            ? buildFoodSearchQuery(queryTokens.productTokens, queryTokens.normalizedProductQuery)
            : buildFoodSearchQuery(queryTokens.productTokens, queryTokens.normalizedQuery);

        const dataTypes = brandScoped ? USDA_BRANDED_DATA_TYPES : USDA_DEFAULT_DATA_TYPES;

        const baseRequest = this.buildSearchRequestBody({
            query: upstreamQuery,
            pageSize: upstreamPageSize,
            pageNumber,
            dataTypes
        });

        const responses: UsdaFoodsSearchResponse[] = [];
        let brandOwnerResponse: UsdaFoodsSearchResponse | null = null;

        if (brandScoped && hasExplicitProductTerms && queryTokens.normalizedBrandQuery) {
            const combinedQuery = buildFoodSearchQuery(
                [...queryTokens.brandTokens, ...queryTokens.productTokens],
                `${queryTokens.normalizedBrandQuery} ${queryTokens.normalizedProductQuery}`.trim()
            );

            const combinedResponse = await this.executeSearchWithRequireAllWordsFallback(
                this.buildSearchRequestBody({
                    query: combinedQuery,
                    pageSize: upstreamPageSize,
                    pageNumber,
                    dataTypes: USDA_BRANDED_DATA_TYPES
                }),
                true
            );

            responses.push(combinedResponse);
        }

        if (brandScoped && hasExplicitProductTerms && queryTokens.rawBrandOwnerQuery) {
            for (const candidate of this.buildBrandOwnerCandidates(queryTokens)) {
                const brandOwnerBody: UsdaFoodsSearchRequestBody = {
                    ...baseRequest,
                    brandOwner: candidate,
                    ...(requireAllWords ? { requireAllWords: true } : {})
                };

                const candidateResponse = await this.executeOptionalSearch(brandOwnerBody, {
                    retryWithoutRequireAllWords: requireAllWords
                });

                if (Array.isArray(candidateResponse?.foods) && candidateResponse.foods.length > 0) {
                    brandOwnerResponse = candidateResponse;
                    responses.push(candidateResponse);
                    break;
                }
            }
        }

        const primaryResponse = await this.executeSearchWithRequireAllWordsFallback(baseRequest, requireAllWords);
        responses.push(primaryResponse);

        if (brandScoped && queryTokens.normalizedBrandQuery) {
            const brandResponse = await this.executeSearchWithRequireAllWordsFallback(
                this.buildSearchRequestBody({
                    query: buildFoodSearchQuery(queryTokens.brandTokens, queryTokens.normalizedBrandQuery),
                    pageSize: upstreamPageSize,
                    pageNumber,
                    dataTypes: USDA_BRANDED_DATA_TYPES
                }),
                queryTokens.brandTokens.length >= 2
            );
            responses.push(brandResponse);
        }

        if (brandScoped && hasExplicitProductTerms) {
            const primaryHasFoods = Array.isArray(primaryResponse.foods) && primaryResponse.foods.length > 0;
            const brandOwnerHasFoods = Array.isArray(brandOwnerResponse?.foods) && brandOwnerResponse.foods.length > 0;

            if (!primaryHasFoods && !brandOwnerHasFoods) {
                // Include a broader fallback to avoid "no results" when the branded-only dataset is sparse for the query.
                const fallbackResponse = await this.executeSearchWithRequireAllWordsFallback(
                    this.buildSearchRequestBody({
                        query: upstreamQuery,
                        pageSize: upstreamPageSize,
                        pageNumber,
                        dataTypes: USDA_DEFAULT_DATA_TYPES
                    }),
                    requireAllWords
                );
                responses.push(fallbackResponse);
            }
        }

        const foods = this.mergeFoodsUnique(responses);
        const items = this.normalizeFoods(foods, request);

        const ranked = this.rankItems(items, queryTokens);
        return { items: ranked.slice(0, pageSize) };
    }

    /**
     * Build the request body for `/foods/search` using safe defaults.
     */
    private buildSearchRequestBody(params: {
        query: string;
        pageSize: number;
        pageNumber: number;
        dataTypes?: string[];
    }): UsdaFoodsSearchRequestBody {
        return {
            query: params.query,
            pageSize: params.pageSize,
            pageNumber: params.pageNumber,
            dataType: params.dataTypes ?? USDA_DEFAULT_DATA_TYPES
        };
    }

    /**
     * Determine whether a query is likely improved by requiring every search term to appear.
     */
    private shouldRequireAllWords(productTokens: string[]): boolean {
        return productTokens.length >= 2;
    }

    /**
     * Fetch more upstream results for multi-term queries so local relevance ranking has enough candidates to work with.
     */
    private resolveUpstreamPageSize(requested: number, tokens?: UsdaQueryTokens): number {
        if (!tokens) {
            return requested;
        }

        const totalTokens = tokens.brandTokens.length + tokens.productTokens.length;
        if (totalTokens >= 2) {
            return USDA_MAX_UPSTREAM_PAGE_SIZE;
        }

        return requested;
    }

    /**
     * Normalize UPC/EAN strings so comparisons ignore whitespace/punctuation differences.
     */
    private normalizeBarcodeValue(value: string): string {
        return value.replace(/[^0-9]/g, '').trim();
    }

    /**
     * Normalize USDA API foods into the app item shape, applying any request scaling and includeIncomplete rules.
     */
    private normalizeFoods(foods: UsdaFood[] | undefined, request: FoodSearchRequest): NormalizedFoodItem[] {
        if (!Array.isArray(foods)) {
            return [];
        }

        return foods
            .map((food: UsdaFood) => this.normalizeFood(food, request.quantityInGrams, request.includeIncomplete))
            .filter((item: NormalizedFoodItem | null): item is NormalizedFoodItem => Boolean(item));
    }

    /**
     * Execute an upstream search request and return the parsed JSON response.
     */
    private async executeSearch(body: UsdaFoodsSearchRequestBody): Promise<UsdaFoodsSearchResponse> {
        const response = await fetch(`${this.baseUrl}/foods/search?api_key=${this.apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const message = await response.text();
            const error = new Error(`USDA search failed: ${response.status} ${message}`);
            (error as Error & { status?: number }).status = response.status;
            throw error;
        }

        return response.json();
    }

    /**
     * Execute a search using `requireAllWords=true`, falling back to a relaxed query when unsupported or empty.
     */
    private async executeSearchWithRequireAllWordsFallback(
        baseBody: UsdaFoodsSearchRequestBody,
        requireAllWords: boolean
    ): Promise<UsdaFoodsSearchResponse> {
        if (!requireAllWords) {
            return this.executeSearch(baseBody);
        }

        const strictBody: UsdaFoodsSearchRequestBody = { ...baseBody, requireAllWords: true };
        try {
            const strictResult = await this.executeSearch(strictBody);
            if (Array.isArray(strictResult.foods) && strictResult.foods.length > 0) {
                return strictResult;
            }
            return this.executeSearch(baseBody);
        } catch (error) {
            if (this.getUsdaHttpStatus(error) === 400) {
                return this.executeSearch(baseBody);
            }
            throw error;
        }
    }

    /**
     * Execute a search that may not be supported by the upstream API (e.g., brand owner filtering).
     */
    private async executeOptionalSearch(
        body: UsdaFoodsSearchRequestBody,
        options?: { retryWithoutRequireAllWords?: boolean }
    ): Promise<UsdaFoodsSearchResponse | null> {
        try {
            return await this.executeSearch(body);
        } catch (error) {
            if (this.getUsdaHttpStatus(error) === 400 && options?.retryWithoutRequireAllWords && body.requireAllWords) {
                const retryBody = { ...body };
                delete retryBody.requireAllWords;
                try {
                    return await this.executeSearch(retryBody);
                } catch (retryError) {
                    if (this.getUsdaHttpStatus(retryError) === 400) {
                        return null;
                    }
                    throw retryError;
                }
            }

            if (this.getUsdaHttpStatus(error) === 400) {
                return null;
            }
            throw error;
        }
    }

    /**
     * Merge multiple upstream responses into a single unique set keyed by `fdcId`.
     */
    private mergeFoodsUnique(responses: UsdaFoodsSearchResponse[]): UsdaFood[] {
        const seen = new Map<number, UsdaFood>();
        for (const response of responses) {
            if (!Array.isArray(response.foods)) {
                continue;
            }
            for (const food of response.foods) {
                if (food && typeof food.fdcId === 'number') {
                    seen.set(food.fdcId, food);
                }
            }
        }

        return [...seen.values()];
    }

    /**
     * Extract an HTTP status code from errors raised by `executeSearch`.
     */
    private getUsdaHttpStatus(error: unknown): number | undefined {
        if (error && typeof error === 'object' && 'status' in error) {
            const status = (error as { status?: unknown }).status;
            if (typeof status === 'number') {
                return status;
            }
        }

        return undefined;
    }

    /**
     * Normalize brand owner queries to match common upstream formatting (e.g., curly -> straight apostrophes).
     */
    private normalizeBrandOwnerQuery(value: string): string {
        return value.replace(/\u2019/g, "'").trim();
    }

    /**
     * Generate candidate values for the USDA `brandOwner` filter from a user-entered brand phrase.
     */
    private buildBrandOwnerCandidates(tokens: UsdaQueryTokens): string[] {
        const candidates = new Set<string>();

        if (tokens.rawBrandOwnerQuery) {
            const normalized = this.normalizeBrandOwnerQuery(tokens.rawBrandOwnerQuery);
            candidates.add(normalized);
            candidates.add(normalized.replace(/'/g, '').trim());
            candidates.add(normalized.toUpperCase());
            candidates.add(normalized.replace(/'/g, '').trim().toUpperCase());
        }

        if (tokens.normalizedBrandQuery) {
            const normalizedBrand = tokens.normalizedBrandQuery.trim();
            if (normalizedBrand) {
                candidates.add(normalizedBrand);
                candidates.add(`${normalizedBrand}s`);
                candidates.add(normalizedBrand.toUpperCase());
                candidates.add(`${normalizedBrand}s`.toUpperCase());
            }
        }

        return [...candidates].map((value) => value.trim()).filter(Boolean);
    }

    /** Normalize text into comparable tokens for ranking and query heuristics. */
    private tokenizeQuery(query: string): string[] {
        return tokenizeFoodSearchQuery(query);
    }

    /**
     * Split a query into brand vs. product tokens using a possessive heuristic ("trader joe's ...").
     */
    private splitQueryTokens(query: string): UsdaQueryTokens {
        const normalizedQuery = normalizeFoodSearchText(query);
        const lower = query.toLowerCase();
        const straightIndex = lower.indexOf("'s");
        const curlyIndex = lower.indexOf('\u2019s');
        const possessiveIndexCandidates = [straightIndex, curlyIndex].filter((idx) => idx >= 0);
        const possessiveIndex = possessiveIndexCandidates.length > 0 ? Math.min(...possessiveIndexCandidates) : -1;

        if (possessiveIndex >= 0) {
            const brandPart = query.slice(0, possessiveIndex);
            const productPart = query.slice(possessiveIndex + 2);
            const brandTokens = this.tokenizeQuery(brandPart);
            const productTokens = this.tokenizeQuery(productPart);
            const rawBrandOwnerQuery = query.slice(0, possessiveIndex + 2);
            return {
                normalizedQuery,
                normalizedBrandQuery: normalizeFoodSearchText(brandPart),
                normalizedProductQuery: normalizeFoodSearchText(productPart) || normalizedQuery,
                rawBrandOwnerQuery,
                brandTokens,
                productTokens
            };
        }

        const productTokens = this.tokenizeQuery(query);
        return {
            normalizedQuery,
            normalizedProductQuery: normalizedQuery,
            brandTokens: [],
            productTokens
        };
    }

    /**
     * Apply lightweight relevance scoring so product + brand matches bubble up.
     */
    private rankItems(items: NormalizedFoodItem[], tokens: UsdaQueryTokens): NormalizedFoodItem[] {
        if (!tokens.normalizedQuery) {
            return items;
        }

        const hasQueryTokens = tokens.brandTokens.length > 0 || tokens.productTokens.length > 0;
        if (!hasQueryTokens) {
            return items;
        }

        const productTokenGroups = buildProductTokenGroups(tokens.productTokens);

        const scored = items.map((item, index) => {
            const description = normalizeFoodSearchText(item.description);
            const brand = normalizeFoodSearchText(item.brand);
            const haystack = `${description} ${brand}`.trim();
            const haystackTokens = new Set(this.tokenizeQuery(haystack));

            const productScore = scoreProductTokenGroups(haystackTokens, productTokenGroups);
            const brandMatches = countTokenMatches(haystackTokens, tokens.brandTokens);

            const brandScore = scoreTokenMatches(brandMatches, tokens.brandTokens.length, 50, 10);

            // We weight product matching higher than brand matching so "hot dog" results outrank "Trader Joe's hot sauce".
            let score = productScore + brandScore;

            if (description === tokens.normalizedQuery) {
                score += 40;
            } else if (description.startsWith(tokens.normalizedQuery)) {
                score += 25;
            } else if (description.includes(tokens.normalizedQuery)) {
                score += 10;
            }

            if (tokens.normalizedProductQuery && tokens.normalizedProductQuery !== tokens.normalizedQuery) {
                if (description.includes(tokens.normalizedProductQuery)) {
                    score += 10;
                }
            }

            // Prefer packaged/branded entries when other signals are comparable.
            if (item.brand || item.barcode) {
                score += 5;
            }

            if (item.nutrientsPer100g?.calories !== undefined) {
                score += 2;
            }

            return { item, score, index };
        });

        const hasScore = scored.some(({ score }) => score > 0);
        if (!hasScore) {
            return items;
        }

        scored.sort((a, b) => b.score - a.score || a.index - b.index);
        return scored.map(({ item }) => item);
    }

    private normalizeFood(
        food: UsdaFood,
        quantityInGrams?: number,
        includeIncomplete?: boolean
    ): NormalizedFoodItem | null {
        const measures = this.buildMeasures(food);
        const nutrientsPer100g = this.getNutrientsPer100g(food, measures);
        if (!nutrientsPer100g && !includeIncomplete) {
            return null;
        }

        const nutrientsForRequest = nutrientsPer100g && quantityInGrams
            ? {
                  grams: quantityInGrams,
                  nutrients: scaleNutrients(nutrientsPer100g, quantityInGrams / 100)
              }
            : undefined;

        return {
            id: String(food.fdcId),
            source: 'usda',
            description: food.description || 'Unknown food',
            brand: food.brandOwner || food.brandName || undefined,
            barcode: food.gtinUpc || undefined,
            availableMeasures: measures,
            nutrientsPer100g,
            nutrientsForRequest
        };
    }

    private buildMeasures(food: UsdaFood): FoodMeasure[] {
        const measures: FoodMeasure[] = [];
        const servingSize = parseNumber(food.servingSize);
        const servingUnit = (food.servingSizeUnit || '').toLowerCase();

        if (servingSize) {
            measures.push({
                label: food.householdServingFullText || 'serving',
                gramWeight: this.toGrams(servingSize, servingUnit),
                quantity: servingSize,
                unit: servingUnit || undefined
            });
        }

        if (Array.isArray(food.foodPortions)) {
            food.foodPortions.slice(0, 8).forEach((portion) => {
                if (portion.gramWeight) {
                    measures.push({
                        label: portion.modifier || portion.portionDescription || portion.measureUnit?.name || 'portion',
                        gramWeight: portion.gramWeight
                    });
                }
            });
        }

        measures.push({ label: 'per 100g', gramWeight: 100 });
        return measures;
    }

    private getNutrientsPer100g(food: UsdaFood, measures: FoodMeasure[]): Nutrients | undefined {
        const fromFoodNutrients = this.extractFromFoodNutrients(food.foodNutrients);
        if (fromFoodNutrients?.calories !== undefined) {
            return fromFoodNutrients;
        }

        const servingGramWeight = this.getServingGramWeight(food, measures);
        if (food.labelNutrients && servingGramWeight) {
            const factor = 100 / servingGramWeight;
            return {
                calories: round((food.labelNutrients.calories?.value || 0) * factor, 1),
                protein: food.labelNutrients.protein?.value !== undefined ? round(food.labelNutrients.protein.value * factor, 2) : undefined,
                fat: food.labelNutrients.fat?.value !== undefined ? round(food.labelNutrients.fat.value * factor, 2) : undefined,
                carbs: food.labelNutrients.carbohydrates?.value !== undefined ? round(food.labelNutrients.carbohydrates.value * factor, 2) : undefined
            };
        }

        return undefined;
    }

    private extractFromFoodNutrients(foodNutrients?: FoodNutrient[]): Nutrients | undefined {
        if (!Array.isArray(foodNutrients)) {
            return undefined;
        }

        const findNutrient = (
            codes: string[],
            names: string[],
            options?: { convertKj?: boolean }
        ): number | undefined => {
            const nutrient = foodNutrients.find((n) => {
                const nutrientNumber = n.nutrientNumber || String(n.nutrientId || '');
                const name = (n.nutrientName || '').toLowerCase();
                return (nutrientNumber && codes.includes(nutrientNumber)) || names.some((title) => name.includes(title));
            });

            const amount = nutrient?.amount ?? nutrient?.value;
            if (amount === undefined || amount === null) {
                return undefined;
            }

            const unit = (nutrient?.unitName || '').toLowerCase();
            if (options?.convertKj && unit === 'kj') {
                // Convert kilojoules to kcal if needed.
                return round(amount / 4.184, 1);
            }

            return amount;
        };

        const calories = findNutrient(['1008', '208'], ['energy'], { convertKj: true });
        const protein = findNutrient(['1003', '203'], ['protein']);
        const fat = findNutrient(['1004', '204'], ['fat']);
        const carbs = findNutrient(['1005', '205'], ['carbohydrate', 'carbohydrates']);

        if (calories === undefined && protein === undefined && fat === undefined && carbs === undefined) {
            return undefined;
        }

        return {
            calories: calories ?? 0,
            protein,
            fat,
            carbs
        };
    }

    private getServingGramWeight(food: UsdaFood, measures: FoodMeasure[]): number | undefined {
        const directServing = measures.find((m) => m.label === (food.householdServingFullText || 'serving') && m.gramWeight);
        if (directServing?.gramWeight) {
            return directServing.gramWeight;
        }

        const servingSize = parseNumber(food.servingSize);
        const servingUnit = (food.servingSizeUnit || '').toLowerCase();
        if (servingSize) {
            return this.toGrams(servingSize, servingUnit);
        }

        return undefined;
    }

    private toGrams(amount: number, unit: string): number | undefined {
        if (!amount || !unit) {
            return undefined;
        }

        if (unit === 'g' || unit === 'gram' || unit === 'grams') {
            return amount;
        }
        if (unit === 'oz' || unit === 'ounce' || unit === 'ounces') {
            return round(amount * 28.3495, 2);
        }
        if (unit === 'kg' || unit === 'kilogram' || unit === 'kilograms') {
            return amount * 1000;
        }

        return undefined;
    }
}

export default UsdaFoodDataProvider;
