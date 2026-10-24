/** @file Configured provider selection, credential-aware sequential fallback, and stable paginated food search. */

import FatSecretFoodDataProvider from './fatSecretProvider';
import OpenFoodFactsProvider from './openFoodFactsProvider';
import UsdaFoodDataProvider from './usdaFoodDataProvider';
import { FoodDataProvider, FoodDataSource } from './types';

/**
 * Food data provider registry and resolver helpers.
 */
type FoodDataProviderConfig = {
    label: string;
    supportsBarcodeLookup: boolean;
    requiredEnvVars?: string[];
};

export type FoodDataProviderInfo = {
    name: FoodDataSource;
    label: string;
    supportsBarcodeLookup: boolean;
    ready: boolean;
    detail?: string;
};

type FoodDataProviderResolution = {
    provider?: FoodDataProvider;
    error?: string;
};

const providerRegistry: Record<FoodDataSource, FoodDataProviderConfig> = {
    fatsecret: {
        label: 'FatSecret',
        supportsBarcodeLookup: true,
        requiredEnvVars: ['FATSECRET_CLIENT_ID', 'FATSECRET_CLIENT_SECRET']
    },
    usda: {
        label: 'USDA FoodData Central',
        supportsBarcodeLookup: true,
        requiredEnvVars: ['USDA_API_KEY']
    },
    openFoodFacts: {
        label: 'Open Food Facts',
        supportsBarcodeLookup: true
    }
};

const DEFAULT_PROVIDER: FoodDataSource = 'fatsecret';
// Preferred order for fallback when multiple providers are enabled.
const DEFAULT_PROVIDER_ORDER: FoodDataSource[] = ['fatsecret', 'usda', 'openFoodFacts'];

const providerCache: Partial<Record<FoodDataSource, FoodDataProvider>> = {};
let providerInstance: FoodDataProvider | null = null;
let primaryProviderSelection: PrimaryProviderSelection | null = null;

type PrimaryProviderSelection = {
    normalized: FoodDataSource;
};

const normalizeProviderName = (value: string): FoodDataSource | null => {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'fatsecret') {
        return 'fatsecret';
    }
    if (normalized === 'usda') {
        return 'usda';
    }
    if (normalized === 'openfoodfacts') {
        return 'openFoodFacts';
    }
    return null;
};

const hasEnvValue = (key: string): boolean => {
    const value = process.env[key];
    return typeof value === 'string' && value.trim().length > 0;
};

const getMissingProviderEnvVars = (name: FoodDataSource): string[] => {
    const required = providerRegistry[name].requiredEnvVars ?? [];
    return required.filter((key) => !hasEnvValue(key));
};

const formatMissingEnvDetail = (missing: string[]): string => `Missing ${missing.join(', ')}`;

const formatMissingEnvSentence = (missing: string[]): string => {
    if (missing.length === 1) {
        return `${missing[0]} is missing`;
    }
    return `${missing.join(', ')} are missing`;
};

/**
 * Resolve the primary provider name from environment config once per process.
 */
const resolvePrimaryProviderSelection = (): PrimaryProviderSelection => {
    if (primaryProviderSelection) {
        return primaryProviderSelection;
    }

    const requestedRaw = process.env.FOOD_DATA_PROVIDER;
    const requestedValue = (requestedRaw || DEFAULT_PROVIDER).toLowerCase();
    let normalized = normalizeProviderName(requestedValue);

    if (!normalized) {
        console.warn(
            'FOOD_DATA_PROVIDER is not recognized. ' +
                'Set FOOD_DATA_PROVIDER to fatsecret, usda, or openfoodfacts. Falling back to FatSecret.'
        );
        normalized = DEFAULT_PROVIDER;
    }

    primaryProviderSelection = { normalized };
    return primaryProviderSelection;
};

/**
 * Build a stable provider order starting with the configured primary provider.
 */
const buildProviderOrder = (primary: FoodDataSource): FoodDataSource[] => {
    const order = [primary, ...DEFAULT_PROVIDER_ORDER.filter((name) => name !== primary)];
    const fallbackSet = new Set(order);

    for (const name of Object.keys(providerRegistry) as FoodDataSource[]) {
        if (!fallbackSet.has(name)) {
            order.push(name);
            fallbackSet.add(name);
        }
    }

    return order;
};

/**
 * Pick the first provider in fallback order that has the environment it needs.
 */
const getFirstReadyProviderName = (primary: FoodDataSource): FoodDataSource | null => {
    return buildProviderOrder(primary).find((name) => getMissingProviderEnvVars(name).length === 0) ?? null;
};

export type EnabledFoodDataProviders = {
    primary: FoodDataProviderInfo;
    providers: FoodDataProviderInfo[];
};

/**
 * Return the normalized primary provider name.
 */
export const getPrimaryFoodDataProviderName = (): FoodDataSource => {
    return resolvePrimaryProviderSelection().normalized;
};

/**
 * List enabled providers in fallback order while preserving primary metadata.
 */
export const getEnabledFoodDataProviders = (): EnabledFoodDataProviders => {
    const providers = listFoodDataProviders();
    const primaryName = getPrimaryFoodDataProviderName();
    const primary =
        providers.find((provider) => provider.name === primaryName) ??
        ({
            name: primaryName,
            label: providerRegistry[primaryName]?.label ?? primaryName,
            supportsBarcodeLookup: providerRegistry[primaryName]?.supportsBarcodeLookup ?? false,
            ready: false,
            detail: 'Provider metadata missing.'
        } satisfies FoodDataProviderInfo);

    const orderedNames = buildProviderOrder(primaryName);
    const providersByName = new Map(providers.map((provider) => [provider.name, provider]));
    const orderedReady: FoodDataProviderInfo[] = [];

    for (const name of orderedNames) {
        const provider = providersByName.get(name);
        if (provider?.ready) {
            orderedReady.push(provider);
        }
        providersByName.delete(name);
    }

    for (const provider of providersByName.values()) {
        if (provider.ready) {
            orderedReady.push(provider);
        }
    }

    return { primary, providers: orderedReady };
};

/**
 * Resolve a provider by name, returning a friendly error when configuration is missing.
 */
export const getFoodDataProviderByName = (name: FoodDataSource): FoodDataProviderResolution => {
    const cached = providerCache[name];
    if (cached) {
        return { provider: cached };
    }

    const missing = getMissingProviderEnvVars(name);
    if (missing.length > 0) {
        const config = providerRegistry[name];
        const suffix = missing.length === 1 ? 'Configure it' : 'Configure them';
        return {
            error: `${formatMissingEnvSentence(missing)}. ${suffix} to use ${config.label}.`
        };
    }

    if (name === 'usda') {
        const provider = new UsdaFoodDataProvider(process.env.USDA_API_KEY as string);
        providerCache[name] = provider;
        return { provider };
    }

    if (name === 'fatsecret') {
        const provider = new FatSecretFoodDataProvider(
            process.env.FATSECRET_CLIENT_ID as string,
            process.env.FATSECRET_CLIENT_SECRET as string
        );
        providerCache[name] = provider;
        return { provider };
    }

    const provider = new OpenFoodFactsProvider();
    providerCache[name] = provider;
    return { provider };
};

/**
 * List provider metadata for the dev dashboard without forcing instantiation.
 */
export const listFoodDataProviders = (): FoodDataProviderInfo[] => {
    return (Object.keys(providerRegistry) as FoodDataSource[]).map((name) => {
        const config = providerRegistry[name];
        const missing = getMissingProviderEnvVars(name);
        if (missing.length > 0) {
            return {
                name,
                label: config.label,
                supportsBarcodeLookup: config.supportsBarcodeLookup,
                ready: false,
                detail: formatMissingEnvDetail(missing)
            };
        }

        return {
            name,
            label: config.label,
            supportsBarcodeLookup: config.supportsBarcodeLookup,
            ready: true
        };
    });
};

/**
 * Resolve the configured primary food data provider with a safe fallback.
 */
export const getFoodDataProvider = (): FoodDataProvider => {
    if (providerInstance) {
        return providerInstance;
    }

    const { normalized } = resolvePrimaryProviderSelection();

    const resolution = getFoodDataProviderByName(normalized);
    if (resolution.provider) {
        providerInstance = resolution.provider;
        return providerInstance;
    }

    const fallbackName = getFirstReadyProviderName(normalized) ?? 'openFoodFacts';
    const fallbackLabel = providerRegistry[fallbackName].label;
    const missing = getMissingProviderEnvVars(normalized);
    if (missing.length > 0) {
        const config = providerRegistry[normalized];
        const action = missing.length === 1
            ? `Set ${missing[0]} to enable ${config.label}.`
            : `Set ${missing.join(', ')} to enable ${config.label}.`;
        console.warn(
            `The configured food data provider cannot start because ${formatMissingEnvSentence(missing)}. ` +
                `${action} Falling back to ${fallbackLabel}.`
        );
    } else {
        console.warn(
            'The configured food data provider failed to initialize. ' +
                `Check the provider configuration and credentials. Falling back to ${fallbackLabel}.`
        );
    }

    const fallback = getFoodDataProviderByName(fallbackName);
    providerInstance = fallback.provider ?? new OpenFoodFactsProvider();
    return providerInstance;
};

export * from './types';
