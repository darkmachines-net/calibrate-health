import { FoodDataProvider, FoodMeasure, FoodSearchRequest, FoodSearchResult, NormalizedFoodItem, Nutrients } from './types';
import { parseNumber, round, scaleNutrients } from './utils';

type FatSecretAuthResponse = {
    access_token?: string;
    token_type?: string;
    expires_in?: number | string;
    scope?: string;
    scopes?: string | string[];
};

type FatSecretFoodsSearchResponse = {
    foods?: {
        food?: FatSecretFoodSummary | FatSecretFoodSummary[];
        max_results?: string;
        total_results?: string;
        page_number?: string;
    };
};

type FatSecretFoodSummary = {
    food_id?: string;
    food_name?: string;
    food_type?: string;
    brand_name?: string;
    food_description?: string;
    food_url?: string;
};

type FatSecretFoodGetResponse = {
    food?: FatSecretFoodDetail;
};

type FatSecretFoodDetail = {
    food_id?: string;
    food_name?: string;
    food_type?: string;
    brand_name?: string;
    food_description?: string;
    food_url?: string;
    servings?: {
        serving?: FatSecretServing | FatSecretServing[];
    };
};

type FatSecretServing = {
    serving_id?: string;
    serving_description?: string;
    measurement_description?: string;
    number_of_units?: string;
    metric_serving_amount?: string;
    metric_serving_unit?: string;
    calories?: string;
    protein?: string;
    fat?: string;
    carbohydrate?: string;
};

type FatSecretBarcodeLookupResponse = {
    food_id?: string | number | { value?: string | number } | null;
    food?: FatSecretFoodDetail | FatSecretFoodSummary | null;
};

type FatSecretErrorResponse = {
    error?: {
        code?: string | number;
        message?: string;
    };
};

type DescriptionNutrients = {
    nutrients: Nutrients;
    grams?: number;
};

const FATSECRET_MAX_UPSTREAM_PAGE_SIZE = 50;
const FATSECRET_ACCESS_TOKEN_BUFFER_MS = 60_000;
const FATSECRET_GTIN_LENGTH = 13; // FatSecret barcode lookups require GTIN-13 digits.
const FATSECRET_BARCODE_SCOPE_ERROR_CODE = 14;
const FATSECRET_BARCODE_NOT_FOUND_CODE = 211;

class FatSecretApiError extends Error {
    public code?: string | number;

    constructor(message: string, code?: string | number) {
        super(message);
        this.code = code;
    }
}
class FatSecretFoodDataProvider implements FoodDataProvider {
    public name = 'fatsecret' as const;
    public supportsBarcodeLookup = true;
    private clientId: string;
    private clientSecret: string;
    private baseUrl = 'https://platform.fatsecret.com/rest/server.api';
    private authUrl = 'https://oauth.fatsecret.com/connect/token';
    private accessToken: string | null = null;
    private accessTokenExpiresAt = 0;
    private accessTokenPromise: Promise<string> | null = null;
    private hasLoggedBarcodeScopeWarning = false;

    /**
     * Construct a FatSecret provider instance using OAuth client credentials.
     */
    constructor(clientId: string, clientSecret: string) {
        this.clientId = clientId;
        this.clientSecret = clientSecret;
    }

    async searchFoods(request: FoodSearchRequest): Promise<FoodSearchResult> {
        const trimmedBarcode = request.barcode?.trim();
        const normalizedBarcode = trimmedBarcode ? this.normalizeBarcodeForLookup(trimmedBarcode) : null;
        if (trimmedBarcode) {
            await this.getAccessToken();
            if (this.supportsBarcodeLookup && normalizedBarcode) {
                const barcodeItem = await this.lookupFoodByBarcode(normalizedBarcode, request);
                if (barcodeItem) {
                    return { items: [barcodeItem] };
                }
            }
        }

        const query = (request.query || normalizedBarcode || trimmedBarcode)?.trim();
        if (!query) {
            return { items: [] };
        }

        const pageSize = Math.min(request.pageSize ?? 10, FATSECRET_MAX_UPSTREAM_PAGE_SIZE);
        const pageNumber = Math.max(0, (request.page ?? 1) - 1);

        const searchResponse = await this.executeApiRequest<FatSecretFoodsSearchResponse>({
            method: 'foods.search',
            search_expression: query,
            page_number: pageNumber,
            max_results: pageSize
        });

        const foods = this.normalizeFoodSummaries(searchResponse.foods?.food);
        if (foods.length === 0) {
            return { items: [] };
        }

        const details = await Promise.all(
            foods.map(async (food) => {
                if (!food.food_id) {
                    return null;
                }
                try {
                    return await this.fetchFoodDetails(food.food_id);
                } catch {
                    return null;
                }
            })
        );

        const items = foods
            .map((food, index) => {
                const merged = this.mergeFoodSummaryWithDetail(food, details[index]);
                return this.normalizeFood(merged, request.quantityInGrams, request.includeIncomplete);
            })
            .filter((item): item is NormalizedFoodItem => Boolean(item));

        return { items };
    }

    /**
     * Look up a single barcode and normalize the matching food if the API resolves it.
     */
    private async lookupFoodByBarcode(barcode: string, request: FoodSearchRequest): Promise<NormalizedFoodItem | null> {
        const foodId = await this.findFoodIdForBarcode(barcode);
        if (!foodId) {
            return null;
        }

        const food = await this.fetchFoodDetails(foodId);
        if (!food) {
            return null;
        }

        return this.normalizeFood(food, request.quantityInGrams, request.includeIncomplete, barcode);
    }

    /**
     * Resolve and cache a bearer token so concurrent upstream requests share credentials.
     */
    private async getAccessToken(): Promise<string> {
        if (this.accessToken && Date.now() < this.accessTokenExpiresAt) {
            return this.accessToken;
        }

        if (this.accessTokenPromise) {
            return this.accessTokenPromise;
        }

        this.accessTokenPromise = this.requestAccessToken();
        try {
            return await this.accessTokenPromise;
        } finally {
            this.accessTokenPromise = null;
        }
    }

    /**
     * Request a new OAuth token from FatSecret and record the expiry time for reuse.
     */
    private async requestAccessToken(): Promise<string> {
        const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
        const response = await fetch(this.authUrl, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${credentials}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                grant_type: 'client_credentials'
            })
        });

        if (!response.ok) {
            const message = await response.text();
            throw new Error(`FatSecret auth failed: ${response.status} ${message}`.trim());
        }

        const data = (await response.json()) as FatSecretAuthResponse;
        if (!data.access_token) {
            throw new Error('FatSecret auth failed: access_token is missing.');
        }

        this.updateSupportedScopes(data.scope ?? data.scopes);

        const expiresInSeconds = parseNumber(data.expires_in) ?? 3600;
        const expiresAt = Date.now() + expiresInSeconds * 1000 - FATSECRET_ACCESS_TOKEN_BUFFER_MS;

        this.accessToken = data.access_token;
        this.accessTokenExpiresAt = Math.max(Date.now(), expiresAt);

        return data.access_token;
    }

    /**
     * Record OAuth scopes so the UI can reflect whether barcode lookups are available.
     */
    private updateSupportedScopes(scopeValue: unknown): void {
        if (!scopeValue) {
            return;
        }

        const scopeString = Array.isArray(scopeValue) ? scopeValue.join(' ') : String(scopeValue);
        const scopes = scopeString
            .split(/\s+/)
            .map((scope) => scope.trim().toLowerCase())
            .filter(Boolean);

        if (scopes.length === 0) {
            return;
        }

        const scopeSet = new Set(scopes);
        this.supportsBarcodeLookup = scopeSet.has('barcode');
    }

    /**
     * Normalize UPC/EAN inputs into GTIN-13 digits for FatSecret barcode lookup.
     */
    private normalizeBarcodeForLookup(rawBarcode: string): string | null {
        const digits = rawBarcode.replace(/\D/g, '');
        if (!digits) {
            return null;
        }

        if (digits.length === FATSECRET_GTIN_LENGTH) {
            return digits;
        }

        const upcA = this.expandUpcEToUpcA(digits);
        if (upcA) {
            return upcA.padStart(FATSECRET_GTIN_LENGTH, '0');
        }

        if (digits.length < FATSECRET_GTIN_LENGTH) {
            return digits.padStart(FATSECRET_GTIN_LENGTH, '0');
        }

        if (digits.length === FATSECRET_GTIN_LENGTH + 1 && digits.startsWith('0')) {
            return digits.slice(1);
        }

        return null;
    }

    /**
     * Convert UPC-E digits into their UPC-A equivalent when possible.
     */
    private expandUpcEToUpcA(rawDigits: string): string | null {
        if (!rawDigits) {
            return null;
        }

        let numberSystem = '0';
        let upceBody: string;
        let checkDigit: string | null = null;

        if (rawDigits.length === 6) {
            upceBody = rawDigits;
        } else if (rawDigits.length === 7) {
            numberSystem = rawDigits[0] ?? '0';
            upceBody = rawDigits.slice(1);
        } else if (rawDigits.length === 8) {
            numberSystem = rawDigits[0] ?? '0';
            upceBody = rawDigits.slice(1, 7);
            checkDigit = rawDigits[7] ?? null;
        } else {
            return null;
        }

        if (!/^\d{6}$/.test(upceBody)) {
            return null;
        }

        if (numberSystem !== '0' && numberSystem !== '1') {
            return null;
        }

        const digits = upceBody.split('');
        const d1 = digits[0];
        const d2 = digits[1];
        const d3 = digits[2];
        const d4 = digits[3];
        const d5 = digits[4];
        const d6 = digits[5];

        let upcAWithoutCheck: string;
        if (d6 === '0' || d6 === '1' || d6 === '2') {
            upcAWithoutCheck = `${numberSystem}${d1}${d2}${d6}0000${d3}${d4}${d5}`;
        } else if (d6 === '3') {
            upcAWithoutCheck = `${numberSystem}${d1}${d2}${d3}00000${d4}${d5}`;
        } else if (d6 === '4') {
            upcAWithoutCheck = `${numberSystem}${d1}${d2}${d3}${d4}00000${d5}`;
        } else {
            upcAWithoutCheck = `${numberSystem}${d1}${d2}${d3}${d4}${d5}0000${d6}`;
        }

        if (!/^\d{11}$/.test(upcAWithoutCheck)) {
            return null;
        }

        const computedCheckDigit = this.computeUpcACheckDigit(upcAWithoutCheck);
        if (computedCheckDigit === null) {
            return null;
        }

        if (checkDigit && checkDigit !== computedCheckDigit) {
            return null;
        }

        return `${upcAWithoutCheck}${computedCheckDigit}`;
    }

    /**
     * Calculate a UPC-A check digit from the 11-digit body.
     */
    private computeUpcACheckDigit(upcAWithoutCheck: string): string | null {
        if (!/^\d{11}$/.test(upcAWithoutCheck)) {
            return null;
        }

        let sumOdd = 0;
        let sumEven = 0;
        for (let i = 0; i < upcAWithoutCheck.length; i += 1) {
            const digit = Number(upcAWithoutCheck[i]);
            if (!Number.isFinite(digit)) {
                return null;
            }
            if (i % 2 === 0) {
                sumOdd += digit;
            } else {
                sumEven += digit;
            }
        }

        const total = sumOdd * 3 + sumEven;
        const remainder = total % 10;
        const checkDigit = remainder === 0 ? 0 : 10 - remainder;
        return String(checkDigit);
    }

    /**
     * Execute a FatSecret REST call with the current OAuth token and JSON response handling.
     */
    private async executeApiRequest<T>(params: Record<string, string | number | undefined>): Promise<T> {
        const token = await this.getAccessToken();
        const searchParams = new URLSearchParams({ format: 'json' });

        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null && String(value).trim().length > 0) {
                searchParams.set(key, String(value));
            }
        });

        const response = await fetch(`${this.baseUrl}?${searchParams.toString()}`, {
            headers: {
                Authorization: `Bearer ${token}`
            }
        });

        const payload = await response.json();
        const apiError = this.parseApiError(payload);

        if (!response.ok) {
            if (apiError) {
                throw new FatSecretApiError(
                    `FatSecret API error${apiError.code !== undefined ? ` (${apiError.code})` : ''}: ${
                        apiError.message || 'Unknown error'
                    }`,
                    apiError.code
                );
            }

            const message = typeof payload === 'object' && payload ? JSON.stringify(payload) : String(payload);
            throw new Error(`FatSecret request failed: ${response.status} ${message}`.trim());
        }

        if (apiError) {
            throw new FatSecretApiError(
                `FatSecret API error${apiError.code !== undefined ? ` (${apiError.code})` : ''}: ${
                    apiError.message || 'Unknown error'
                }`,
                apiError.code
            );
        }

        return payload as T;
    }

    /**
     * Use the barcode endpoint to resolve a FatSecret food id.
     */
    private async findFoodIdForBarcode(barcode: string): Promise<string | null> {
        let response: FatSecretBarcodeLookupResponse;
        try {
            response = await this.executeApiRequest<FatSecretBarcodeLookupResponse>({
                method: 'food.find_id_for_barcode.v2',
                barcode
            });
        } catch (error) {
            if (this.shouldDisableBarcodeLookup(error)) {
                this.supportsBarcodeLookup = false;
                this.warnMissingBarcodeScope();
                return null;
            }
            if (this.isBarcodeNotFoundError(error)) {
                return null;
            }
            throw error;
        }

        const candidateSources = [
            response?.food_id,
            (response as { food?: { food_id?: unknown } | null })?.food?.food_id,
            (response as { foods?: { food_id?: unknown } | null })?.foods?.food_id
        ];

        for (const value of candidateSources) {
            if (typeof value === 'string' || typeof value === 'number') {
                return String(value);
            }
            if (value && typeof value === 'object' && 'value' in value) {
                const nested = (value as { value?: unknown }).value;
                if (typeof nested === 'string' || typeof nested === 'number') {
                    return String(nested);
                }
            }
        }

        return null;
    }

    private shouldDisableBarcodeLookup(error: unknown): boolean {
        if (!(error instanceof FatSecretApiError)) {
            return false;
        }

        if (error.code === FATSECRET_BARCODE_SCOPE_ERROR_CODE) {
            return true;
        }

        return /scope/i.test(error.message);
    }

    private isBarcodeNotFoundError(error: unknown): boolean {
        if (!(error instanceof FatSecretApiError)) {
            return false;
        }

        return error.code === FATSECRET_BARCODE_NOT_FOUND_CODE;
    }

    private warnMissingBarcodeScope(): void {
        if (this.hasLoggedBarcodeScopeWarning) {
            return;
        }
        this.hasLoggedBarcodeScopeWarning = true;

        console.warn(
            'FatSecret barcode lookup failed due to a missing scope. Barcode lookup is disabled. ' +
                'Enable the FatSecret barcode scope or remove barcode scanning from the UI.'
        );
    }

    /**
     * Fetch full nutrition + serving details for a specific food id.
     */
    private async fetchFoodDetails(foodId: string): Promise<FatSecretFoodDetail | null> {
        const response = await this.executeApiRequest<FatSecretFoodGetResponse>({
            method: 'food.get',
            food_id: foodId
        });

        return response.food ?? null;
    }

    /**
     * Normalize FatSecret API foods into the app's canonical food item shape.
     */
    private normalizeFood(
        food: FatSecretFoodDetail | FatSecretFoodSummary,
        quantityInGrams?: number,
        includeIncomplete?: boolean,
        barcodeOverride?: string
    ): NormalizedFoodItem | null {
        const measures = this.buildMeasures(food);
        const nutrientsPer100g = this.getNutrientsPer100g(food);
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
            id: food.food_id ? String(food.food_id) : `fatsecret:${food.food_name || 'unknown'}`,
            source: 'fatsecret',
            description: food.food_name || 'Unknown food',
            brand: food.brand_name || undefined,
            barcode: barcodeOverride,
            availableMeasures: measures,
            nutrientsPer100g,
            nutrientsForRequest
        };
    }

    /**
     * Ensure the search response is always treated as a list, even for single-item payloads.
     */
    private normalizeFoodSummaries(
        foods?: FatSecretFoodSummary | FatSecretFoodSummary[]
    ): FatSecretFoodSummary[] {
        if (!foods) {
            return [];
        }
        return Array.isArray(foods) ? foods : [foods];
    }

    /**
     * Extract serving entries from food details, normalizing the array/object payload shape.
     */
    private getServings(food: FatSecretFoodDetail | FatSecretFoodSummary): FatSecretServing[] {
        if (!('servings' in food) || !food.servings) {
            return [];
        }

        const rawServings = Array.isArray(food.servings) ? food.servings : food.servings.serving;
        if (!rawServings) {
            return [];
        }

        return Array.isArray(rawServings) ? rawServings : [rawServings];
    }

    /**
     * Build standardized measure options from FatSecret serving data.
     */
    private buildMeasures(food: FatSecretFoodDetail | FatSecretFoodSummary): FoodMeasure[] {
        const measures: FoodMeasure[] = [];
        const seen = new Set<string>();

        const pushMeasure = (measure: FoodMeasure) => {
            const key = `${measure.label}|${measure.gramWeight ?? ''}`;
            if (seen.has(key)) {
                return;
            }
            measures.push(measure);
            seen.add(key);
        };

        this.getServings(food).slice(0, 8).forEach((serving) => {
            const label = (serving.serving_description || serving.measurement_description || 'serving').trim() || 'serving';
            const gramWeight =
                this.resolveMetricWeight(serving.metric_serving_amount, serving.metric_serving_unit) ??
                this.parseGramWeightFromDescription(serving.serving_description);

            if (!gramWeight) {
                return;
            }

            const unit = serving.measurement_description?.trim();
            pushMeasure({
                label,
                gramWeight,
                quantity: parseNumber(serving.number_of_units),
                unit: unit || undefined
            });
        });

        pushMeasure({ label: 'per 100g', gramWeight: 100 });
        return measures;
    }

    /**
     * Preserve summary nutrition hints when the detail payload omits them.
     */
    private mergeFoodSummaryWithDetail(
        summary: FatSecretFoodSummary,
        detail: FatSecretFoodDetail | null
    ): FatSecretFoodDetail | FatSecretFoodSummary {
        if (!detail) {
            return summary;
        }

        return {
            ...summary,
            ...detail,
            food_id: detail.food_id ?? summary.food_id,
            food_name: detail.food_name ?? summary.food_name,
            brand_name: detail.brand_name ?? summary.brand_name,
            food_type: detail.food_type ?? summary.food_type,
            food_description: detail.food_description ?? summary.food_description,
            food_url: detail.food_url ?? summary.food_url
        };
    }

    /**
     * Build the per-100g nutrient view using serving data first, then description parsing as fallback.
     */
    private getNutrientsPer100g(food: FatSecretFoodDetail | FatSecretFoodSummary): Nutrients | undefined {
        const servings = this.getServings(food);
        for (const serving of servings) {
            const nutrients = this.extractServingNutrients(serving);
            const gramWeight = this.resolveMetricWeight(serving.metric_serving_amount, serving.metric_serving_unit);
            if (nutrients && gramWeight) {
                return this.scaleTo100g(nutrients, gramWeight);
            }
        }

        const fromDescription = this.parseNutrientsFromDescription(food.food_description);
        if (fromDescription) {
            if (fromDescription.grams) {
                return this.scaleTo100g(fromDescription.nutrients, fromDescription.grams);
            }
            return fromDescription.nutrients;
        }

        return undefined;
    }

    /**
     * Normalize error payloads so upstream failures don't look like empty results.
     */
    private parseApiError(payload: unknown): { code?: string | number; message?: string } | null {
        if (!payload || typeof payload !== 'object') {
            return null;
        }

        if (!('error' in payload)) {
            return null;
        }

        const errorValue = (payload as FatSecretErrorResponse).error;
        if (!errorValue) {
            return null;
        }

        if (typeof errorValue === 'string') {
            return { message: errorValue };
        }

        if (typeof errorValue === 'object') {
            const code = errorValue.code;
            const message = errorValue.message;
            if (code !== undefined || message) {
                return { code, message };
            }
        }

        return null;
    }

    /**
     * Extract macro values from a FatSecret serving payload.
     */
    private extractServingNutrients(serving: FatSecretServing): Nutrients | undefined {
        const calories = parseNumber(serving.calories);
        const protein = parseNumber(serving.protein);
        const fat = parseNumber(serving.fat);
        const carbs = parseNumber(serving.carbohydrate);

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

    /**
     * Parse the compact FatSecret description string for nutrient hints.
     */
    private parseNutrientsFromDescription(description?: string): DescriptionNutrients | undefined {
        if (!description) {
            return undefined;
        }

        const calories = this.parseDescriptionValue(description, /Calories:\s*([0-9.]+)\s*k?cal/i);
        const fat = this.parseDescriptionValue(description, /Fat:\s*([0-9.]+)\s*g/i);
        const carbs = this.parseDescriptionValue(description, /Carb(?:s|ohydrate[s]?)?:\s*([0-9.]+)\s*g/i);
        const protein = this.parseDescriptionValue(description, /Protein:\s*([0-9.]+)\s*g/i);

        if (calories === undefined && protein === undefined && fat === undefined && carbs === undefined) {
            return undefined;
        }

        const gramsMatch = description.match(/Per\s+([0-9.]+)\s*(g|ml)\b/i);
        const grams = gramsMatch ? this.resolveMetricWeight(gramsMatch[1], gramsMatch[2]) : undefined;

        return {
            nutrients: {
                calories: calories ?? 0,
                protein,
                fat,
                carbs
            },
            grams
        };
    }

    /**
     * Extract a numeric value from a description string using the provided pattern.
     */
    private parseDescriptionValue(description: string, pattern: RegExp): number | undefined {
        const match = description.match(pattern);
        if (!match) {
            return undefined;
        }
        return parseNumber(match[1]);
    }

    /**
     * Convert metric serving units into grams, assuming 1 ml == 1 g for volume-based entries.
     */
    private resolveMetricWeight(amount: unknown, unit: unknown): number | undefined {
        const quantity = parseNumber(amount);
        if (!quantity) {
            return undefined;
        }

        const normalizedUnit = typeof unit === 'string' ? unit.trim().toLowerCase() : '';
        if (normalizedUnit === 'g' || normalizedUnit === 'gram' || normalizedUnit === 'grams') {
            return quantity;
        }
        if (normalizedUnit === 'ml' || normalizedUnit === 'milliliter' || normalizedUnit === 'milliliters') {
            return quantity;
        }
        if (normalizedUnit === 'kg' || normalizedUnit === 'kilogram' || normalizedUnit === 'kilograms') {
            return quantity * 1000;
        }
        if (normalizedUnit === 'oz' || normalizedUnit === 'ounce' || normalizedUnit === 'ounces') {
            return round(quantity * 28.3495, 2);
        }

        return undefined;
    }

    /**
     * Pull a gram/ml hint from a serving description when metric weights are missing.
     */
    private parseGramWeightFromDescription(description?: string): number | undefined {
        if (!description) {
            return undefined;
        }

        const match = description.match(/([0-9.]+)\s*(g|ml)\b/i);
        if (!match) {
            return undefined;
        }

        return this.resolveMetricWeight(match[1], match[2]);
    }

    /**
     * Normalize nutrient quantities to a per-100g basis.
     */
    private scaleTo100g(nutrients: Nutrients, grams: number): Nutrients {
        if (!grams || grams <= 0) {
            return nutrients;
        }
        return scaleNutrients(nutrients, 100 / grams);
    }
}

export default FatSecretFoodDataProvider;
