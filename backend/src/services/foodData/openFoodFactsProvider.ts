/** @file Open Food Facts text/barcode lookup and normalization into the shared food-provider contract. */

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
 * Open Food Facts provider implementation with local relevance ranking.
 */
type OpenFoodFactsProduct = {
    code?: string;
    product_name?: string;
    generic_name?: string;
    brands?: string;
    nutriments?: Record<string, unknown>;
    serving_size?: string;
    serving_quantity?: number | string;
    product_quantity?: number;
    quantity?: string;
    lc?: string;
};

type OpenFoodFactsQueryTokens = {
    normalizedQuery: string;
    normalizedBrandQuery?: string;
    normalizedProductQuery: string;
    brandTokens: string[];
    productTokens: string[];
};

// Pull more candidates for local relevance ranking without issuing multiple upstream pages.
const OFF_MAX_UPSTREAM_PAGE_SIZE = 50;
const OFF_UPSTREAM_PAGE_SIZE_BOOST = 25;
// Prevent tiny tokens like "'s" -> "s" from matching almost everything.
const OFF_MIN_TOKEN_LENGTH = 2;
// Require strong product matches for possessive brand queries so token collisions ("hot sauce" vs "hot dog") are filtered out.
const OFF_MIN_PRODUCT_SCORE_FOR_POSSESSIVE_QUERY = 20;

const OFF_STOP_WORDS = new Set(['the', 'and', 'or', 'with', 'for', 'from', 'of', 'to', 'in', 'on']);

/**
 * Food data provider backed by Open Food Facts search and product endpoints.
 */
class OpenFoodFactsProvider implements FoodDataProvider {
    public name = 'openFoodFacts' as const;
    public supportsBarcodeLookup = true;
    private baseUrl = 'https://world.openfoodfacts.org';
    private searchFields =
        'product_name,generic_name,brands,code,nutriments,serving_size,serving_quantity,product_quantity,quantity,lc';
    private requestTimeoutMs: number;
    private searchMode: 'auto' | 'v2' | 'legacy';

    /**
     * Construct an Open Food Facts provider instance.
     *
     * Env tuning:
     * - `OFF_TIMEOUT_MS`: request timeout (ms); set to `0` to disable.
     * - `OFF_SEARCH_MODE`: `auto` (default), `v2`, or `legacy`.
     */
    constructor() {
        const configured = process.env.OFF_TIMEOUT_MS;
        const parsed = configured ? parseInt(configured, 10) : Number.NaN;
        this.requestTimeoutMs = Number.isFinite(parsed) && parsed >= 0 ? parsed : 8000;

        const mode = (process.env.OFF_SEARCH_MODE || 'auto').toLowerCase();
        if (mode === 'auto' || mode === 'v2' || mode === 'legacy') {
            this.searchMode = mode;
        } else {
            this.searchMode = 'auto';
        }
    }

    /** Try exact barcode lookup before bounded text search and normalize products under the requested completeness policy. */
    async searchFoods(request: FoodSearchRequest): Promise<FoodSearchResult> {
        if (request.barcode) {
            const product = await this.fetchProductByBarcode(request.barcode, request.languageCode);
            if (product) {
                const item = this.normalizeProduct(product, request.quantityInGrams, request.includeIncomplete);
                return { items: item ? [item] : [] };
            }
        }

        const query = request.query || request.barcode;
        if (!query) {
            return { items: [] };
        }

        const pageSize = Math.min(request.pageSize ?? 10, OFF_MAX_UPSTREAM_PAGE_SIZE);
        const page = request.page ?? 1;
        const queryTokens = this.splitQueryTokens(query);
        const upstreamQuery = buildFoodSearchQuery(
            [...queryTokens.brandTokens, ...queryTokens.productTokens],
            queryTokens.normalizedQuery || query
        );
        const upstreamPageSize = this.resolveUpstreamPageSize(pageSize, queryTokens);

        if (this.searchMode === 'legacy') {
            const legacyResponse = await this.fetchSearchResponseLegacy(
                upstreamQuery,
                upstreamPageSize,
                page,
                request.languageCode
            );
            if (!legacyResponse.ok) {
                const legacyMessage = await this.describeSearchFailure('legacy', legacyResponse);
                throw new Error(`Open Food Facts search failed. ${legacyMessage}`);
            }

            let legacyItems = await this.parseItemsFromResponse(legacyResponse, request);
            legacyItems = await this.maybeMergeBrandScopedLegacyResults(
                legacyItems,
                queryTokens,
                upstreamPageSize,
                page,
                request.languageCode,
                request
            );

            return this.buildSearchResult(legacyItems, queryTokens, pageSize, request.languageCode);
        }

        let v2Response: Response | null = null;
        let v2Error: unknown;
        try {
            v2Response = await this.fetchSearchResponseV2(upstreamQuery, upstreamPageSize, page, request.languageCode);
        } catch (error) {
            v2Error = error;
        }

        if (this.searchMode === 'v2') {
            if (!v2Response?.ok) {
                const v2Message = await this.describeSearchFailure('v2', v2Response, v2Error);
                throw new Error(`Open Food Facts search failed. ${v2Message}`);
            }

            const v2Items = await this.parseItemsFromResponse(v2Response, request);
            return this.buildSearchResult(v2Items, queryTokens, pageSize, request.languageCode);
        }

        let items: NormalizedFoodItem[] = [];
        if (v2Response?.ok) {
            items = await this.parseItemsFromResponse(v2Response, request);
        }

        if (!v2Response?.ok || this.countQueryMatches(items, queryTokens) === 0) {
            const legacyResponse = await this.fetchSearchResponseLegacy(
                upstreamQuery,
                upstreamPageSize,
                page,
                request.languageCode
            );
            if (legacyResponse.ok) {
                items = await this.parseItemsFromResponse(legacyResponse, request);
            } else if (!v2Response?.ok) {
                const v2Message = await this.describeSearchFailure('v2', v2Response, v2Error);
                const legacyMessage = await this.describeSearchFailure('legacy', legacyResponse);
                throw new Error(`Open Food Facts search failed. ${v2Message}; ${legacyMessage}`);
            }
        }

        items = await this.maybeMergeBrandScopedLegacyResults(
            items,
            queryTokens,
            upstreamPageSize,
            page,
            request.languageCode,
            request
        );

        return this.buildSearchResult(items, queryTokens, pageSize, request.languageCode);
    }

    /**
     * Convert API payloads into normalized items for reuse across search modes.
     */
    private async parseItemsFromResponse(
        response: Response,
        request: FoodSearchRequest
    ): Promise<NormalizedFoodItem[]> {
        const data = await response.json();
        return Array.isArray(data.products)
            ? data.products
                  .map((product: OpenFoodFactsProduct) =>
                      this.normalizeProduct(product, request.quantityInGrams, request.includeIncomplete)
                  )
                  .filter((item: NormalizedFoodItem | null): item is NormalizedFoodItem => Boolean(item))
            : [];
    }

    /**
     * Cap request time so the dashboard is not blocked by slow upstream calls.
     */
    private async fetchWithTimeout(url: string, headers: Record<string, string>): Promise<Response> {
        if (!this.requestTimeoutMs) {
            return fetch(url, { headers });
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);
        try {
            return await fetch(url, { headers, signal: controller.signal });
        } finally {
            clearTimeout(timeoutId);
        }
    }

    /**
     * Provide a consistent error summary for client responses and logs.
     */
    private async describeSearchFailure(
        label: string,
        response: Response | null,
        error?: unknown
    ): Promise<string> {
        if (response) {
            const message = await response.text();
            return `${label} ${response.status} ${message}`.trim();
        }
        if (error instanceof Error) {
            if (error.name === 'AbortError') {
                return `${label} request timed out after ${this.requestTimeoutMs}ms`;
            }
            return `${label} ${error.message}`;
        }
        return `${label} request failed`;
    }

    /**
     * Use the v2 search endpoint for faster responses.
     */
    private async fetchSearchResponseV2(
        query: string,
        pageSize: number,
        page: number,
        languageCode?: string
    ): Promise<Response> {
        const headers = { 'User-Agent': 'calibrate/food-search' };
        const v2Params = new URLSearchParams({
            search_terms: query,
            page_size: String(pageSize),
            page: String(page),
            fields: this.searchFields,
            sort_by: 'unique_scans_n'
        });
        if (languageCode) {
            v2Params.set('lc', languageCode);
        }
        const v2Url = `${this.baseUrl}/api/v2/search?${v2Params.toString()}`;
        return this.fetchWithTimeout(v2Url, headers);
    }

    /**
     * Use the legacy search endpoint for stronger term matching.
     */
    private async fetchSearchResponseLegacy(
        query: string,
        pageSize: number,
        page: number,
        languageCode?: string,
        options?: { brandTag?: string }
    ): Promise<Response> {
        const headers = { 'User-Agent': 'calibrate/food-search' };
        const legacyParams = new URLSearchParams({
            search_terms: query,
            search_simple: '1',
            json: '1',
            action: 'process',
            page_size: String(pageSize),
            page: String(page),
            fields: this.searchFields,
            sort_by: 'unique_scans_n'
        });
        if (languageCode) {
            legacyParams.set('lc', languageCode);
        }
        if (options?.brandTag) {
            legacyParams.set('tagtype_0', 'brands');
            legacyParams.set('tag_contains_0', 'contains');
            legacyParams.set('tag_0', options.brandTag);
        }
        const legacyUrl = `${this.baseUrl}/cgi/search.pl?${legacyParams.toString()}`;
        return this.fetchWithTimeout(legacyUrl, headers);
    }

    /**
     * Look up a single product by UPC/EAN barcode using the Open Food Facts product endpoint.
     */
    private async fetchProductByBarcode(barcode: string, languageCode?: string): Promise<OpenFoodFactsProduct | null> {
        const params = new URLSearchParams({
            fields: this.searchFields
        });
        if (languageCode) {
            params.set('lc', languageCode);
        }
        const headers = { 'User-Agent': 'calibrate/food-search' };
        const response = await this.fetchWithTimeout(
            `${this.baseUrl}/api/v2/product/${encodeURIComponent(barcode)}?${params.toString()}`,
            headers
        );
        if (!response.ok) {
            return null;
        }

        const data = await response.json();
        if (data.status === 1 && data.product) {
            return data.product as OpenFoodFactsProduct;
        }

        return null;
    }

    /**
     * Convert an Open Food Facts product payload into the normalized app item shape.
     */
    private normalizeProduct(
        product: OpenFoodFactsProduct,
        quantityInGrams?: number,
        includeIncomplete?: boolean
    ): NormalizedFoodItem | null {
        const nutriments = product.nutriments || {};
        const nutrientsPer100g = this.extractNutrientsPer100g(nutriments);
        if (!nutrientsPer100g && !includeIncomplete) {
            return null;
        }

        const description = product.product_name || product.generic_name || 'Unknown food';
        const measures = this.buildMeasures(product);
        const nutrientsForRequest =
            nutrientsPer100g && quantityInGrams && quantityInGrams > 0
                ? {
                      grams: quantityInGrams,
                      nutrients: scaleNutrients(nutrientsPer100g, quantityInGrams / 100)
                  }
                : undefined;

        return {
            id: product.code || product.product_name || product.generic_name || 'openfoodfacts-item',
            source: 'openFoodFacts',
            description,
            brand: product.brands,
            barcode: product.code,
            locale: product.lc,
            availableMeasures: measures,
            nutrientsPer100g: nutrientsPer100g ?? undefined,
            nutrientsForRequest
        };
    }

    /**
     * Apply local filtering + ranking and enforce the requested page size.
     */
    private buildSearchResult(
        items: NormalizedFoodItem[],
        tokens: OpenFoodFactsQueryTokens,
        pageSize: number,
        languageCode?: string
    ): FoodSearchResult {
        const filtered = this.filterItemsByQuery(items, tokens);
        const ranked = this.rankItems(filtered, tokens, languageCode);
        return { items: ranked.slice(0, pageSize) };
    }

    /**
     * Fetch extra candidates for multi-term searches so local ranking has enough signal to work with.
     */
    private resolveUpstreamPageSize(requested: number, tokens: OpenFoodFactsQueryTokens): number {
        const tokenCount = tokens.brandTokens.length + tokens.productTokens.length;
        if (tokenCount >= 3) {
            return OFF_MAX_UPSTREAM_PAGE_SIZE;
        }

        if (tokenCount === 2) {
            return Math.min(Math.max(requested, OFF_UPSTREAM_PAGE_SIZE_BOOST), OFF_MAX_UPSTREAM_PAGE_SIZE);
        }

        return requested;
    }

    /**
     * Attempt a brand-scoped legacy search for possessive queries ("Trader Joe's hot dog") to surface branded matches
     * when the upstream full-text search returns only generic product hits.
     */
    private async maybeMergeBrandScopedLegacyResults(
        items: NormalizedFoodItem[],
        tokens: OpenFoodFactsQueryTokens,
        upstreamPageSize: number,
        page: number,
        languageCode: string | undefined,
        request: FoodSearchRequest
    ): Promise<NormalizedFoodItem[]> {
        if (this.searchMode === 'v2') {
            return items;
        }

        if (tokens.brandTokens.length === 0 || tokens.productTokens.length === 0) {
            return items;
        }

        const filtered = this.filterItemsByQuery(items, tokens);
        if (filtered.length > 0 && this.hasAnyTokenMatch(filtered, tokens.brandTokens)) {
            return items;
        }

        const brandTag = this.buildBrandTag(tokens);
        if (!brandTag) {
            return items;
        }

        const productQuery = buildFoodSearchQuery(tokens.productTokens, tokens.normalizedProductQuery);
        if (!productQuery) {
            return items;
        }

        try {
            const response = await this.fetchSearchResponseLegacy(productQuery, upstreamPageSize, page, languageCode, {
                brandTag
            });
            if (!response.ok) {
                return items;
            }

            const brandItems = await this.parseItemsFromResponse(response, request);
            if (brandItems.length === 0) {
                return items;
            }

            return this.mergeUniqueItems(items, brandItems);
        } catch {
            console.warn('Open Food Facts brand-scoped search failed; continuing with unscoped results (details omitted).');
            return items;
        }
    }

    /**
     * Merge items from multiple upstream responses while deduplicating by `id`.
     */
    private mergeUniqueItems(base: NormalizedFoodItem[], next: NormalizedFoodItem[]): NormalizedFoodItem[] {
        const merged = new Map<string, NormalizedFoodItem>();
        base.forEach((item) => merged.set(item.id, item));
        next.forEach((item) => merged.set(item.id, item));
        return [...merged.values()];
    }

    /**
     * Convert a brand phrase into the slug-style tags Open Food Facts uses for `brands` filters.
     */
    private buildBrandTag(tokens: OpenFoodFactsQueryTokens): string | null {
        const normalized = tokens.normalizedBrandQuery?.trim();
        if (!normalized) {
            return null;
        }

        const slug = normalized
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+/, '')
            .replace(/-+$/, '');

        return slug ? slug : null;
    }

    /**
     * Check whether any of the supplied tokens appear in the normalized haystack for at least one item.
     */
    private hasAnyTokenMatch(items: NormalizedFoodItem[], tokens: string[]): boolean {
        if (tokens.length === 0) {
            return false;
        }

        return items.some((item) => {
            const description = normalizeFoodSearchText(item.description);
            const brand = normalizeFoodSearchText(item.brand);
            const haystack = `${description} ${brand}`.trim();
            const haystackTokens = new Set(this.tokenizeQuery(haystack));
            return countTokenMatches(haystackTokens, tokens) > 0;
        });
    }

    /**
     * Apply lightweight relevance scoring so product name matches bubble up.
     */
    private rankItems(items: NormalizedFoodItem[], tokens: OpenFoodFactsQueryTokens, languageCode?: string): NormalizedFoodItem[] {
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

            // Weight product matching higher than brand matching so "hot dog" outranks "hot sauce".
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

            if (tokens.normalizedBrandQuery && brand.includes(tokens.normalizedBrandQuery)) {
                score += 10;
            }

            if (item.nutrientsPer100g?.calories !== undefined) {
                score += 5;
            }

            if (languageCode && item.locale && item.locale === languageCode) {
                score += 10;
            }

            if (item.brand || item.barcode) {
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

    /** Normalize user queries into stable, stemmed tokens for relevance scoring. */
    private tokenizeQuery(query: string): string[] {
        return tokenizeFoodSearchQuery(query, {
            minTokenLength: OFF_MIN_TOKEN_LENGTH,
            stopWords: OFF_STOP_WORDS
        });
    }

    /**
     * Split a query into brand vs product tokens using a possessive heuristic ("trader joe's ...").
     */
    private splitQueryTokens(query: string): OpenFoodFactsQueryTokens {
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

            if (brandTokens.length > 0 && productTokens.length > 0) {
                return {
                    normalizedQuery,
                    normalizedBrandQuery: normalizeFoodSearchText(brandPart),
                    normalizedProductQuery: normalizeFoodSearchText(productPart) || normalizedQuery,
                    brandTokens,
                    productTokens
                };
            }
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
     * Extract calorie + macro nutrients in 100g units, returning null when calories are missing.
     */
    private extractNutrientsPer100g(nutriments: Record<string, unknown>): Nutrients | null {
        const calories =
            parseNumber(nutriments['energy-kcal_100g']) ??
            (nutriments['energy_100g'] ? round((parseNumber(nutriments['energy_100g']) || 0) / 4.184, 1) : undefined);

        if (calories === undefined) {
            return null;
        }

        const protein = parseNumber(nutriments['proteins_100g']);
        const fat = parseNumber(nutriments['fat_100g']);
        const carbs = parseNumber(nutriments['carbohydrates_100g']);

        return {
            calories,
            protein: protein !== undefined ? round(protein, 2) : undefined,
            fat: fat !== undefined ? round(fat, 2) : undefined,
            carbs: carbs !== undefined ? round(carbs, 2) : undefined
        };
    }

    /**
     * Build a measure list for calorie scaling, preferring explicit per-serving and per-package amounts when present.
     */
    private buildMeasures(product: OpenFoodFactsProduct): FoodMeasure[] {
        const measures: FoodMeasure[] = [{ label: 'per 100g', gramWeight: 100 }];
        const servingGramWeight = this.getServingGramWeight(product);

        if (servingGramWeight) {
            measures.push({
                label: product.serving_size ? `per serving (${product.serving_size})` : 'per serving',
                gramWeight: servingGramWeight
            });
        }

        const productQuantity = parseNumber(product.product_quantity);
        if (productQuantity) {
            measures.push({
                label: product.quantity ? product.quantity : 'package',
                gramWeight: productQuantity
            });
        }

        return measures;
    }

    /**
     * Resolve a serving size gram weight from `serving_quantity` or a parsed `serving_size` string.
     */
    private getServingGramWeight(product: OpenFoodFactsProduct): number | undefined {
        const servingQuantity = parseNumber(product.serving_quantity);
        if (servingQuantity) {
            return servingQuantity;
        }

        if (!product.serving_size) {
            return undefined;
        }

        const match = product.serving_size.match(/([\d.,]+)\s*(g|ml|oz)/i);
        if (!match) {
            return undefined;
        }

        const amount = parseNumber(match[1]);
        const unit = match[2].toLowerCase();

        if (!amount) {
            return undefined;
        }

        if (unit === 'g' || unit === 'ml') {
            return amount;
        }

        if (unit === 'oz') {
            return round(amount * 28.3495, 2);
        }

        return undefined;
    }

    /**
     * Remove items that do not include any meaningful query tokens.
     */
    private filterItemsByQuery(items: NormalizedFoodItem[], tokens: OpenFoodFactsQueryTokens): NormalizedFoodItem[] {
        const queryTokens = [...tokens.brandTokens, ...tokens.productTokens];
        if (queryTokens.length === 0) {
            return items;
        }

        const productTokenGroups = buildProductTokenGroups(tokens.productTokens);
        const requireStrongProductMatch = tokens.brandTokens.length > 0 && tokens.productTokens.length > 0;

        return items.filter((item) => {
            const description = normalizeFoodSearchText(item.description);
            const brand = normalizeFoodSearchText(item.brand);
            const haystack = `${description} ${brand}`.trim();
            if (!haystack) {
                return false;
            }

            const haystackTokens = new Set(this.tokenizeQuery(haystack));

            if (requireStrongProductMatch) {
                // Require at least two product token hits (or a synonym group) so "hot sauce" does not match "hot dog".
                const productScore = scoreProductTokenGroups(haystackTokens, productTokenGroups);
                return productScore >= OFF_MIN_PRODUCT_SCORE_FOR_POSSESSIVE_QUERY;
            }

            return queryTokens.some((token) => this.haystackIncludesToken(haystackTokens, haystack, token));
        });
    }

    /**
     * Count how many items survive local token filtering (used to decide when to fall back from v2 to legacy search).
     */
    private countQueryMatches(items: NormalizedFoodItem[], tokens: OpenFoodFactsQueryTokens): number {
        return this.filterItemsByQuery(items, tokens).length;
    }

    /**
     * Match a token by word (preferred) and optionally by substring for longer tokens ("burger" in "hamburger").
     */
    private haystackIncludesToken(haystackTokens: ReadonlySet<string>, haystack: string, token: string): boolean {
        if (haystackTokens.has(token)) {
            return true;
        }

        return token.length >= 4 && haystack.includes(token);
    }

}

export default OpenFoodFactsProvider;
