/** @file Authenticated food logging, provider search, snapshot edits, and copy operations. */

import express from 'express';
import { observeFoodActivityPlan } from '../services/dailyCaloriePlans';
import { lockCaloriePlanningInputs } from '../services/caloriePlanningLock';
import type { Prisma } from '@prisma/client';
import prisma from '../config/database';
import {
    getEnabledFoodDataProviders,
    getFoodDataProviderByName,
    type FoodDataSource
} from '../services/foodData';
import type { FoodDataProvider, FoodSearchRequest, FoodSearchResult } from '../services/foodData';
import {
    ClientOperationConflictError,
    executeIdempotentMutation,
    parseClientOperationId,
    recordSyncChange
} from '../services/clientOperations';
import { parseLocalDateOnly } from '../utils/date';
import { parseMealPeriod } from '../utils/mealPeriod';
import { parsePositiveInteger } from '../utils/requestParsing';
import { parseFoodLogCreateBody, parseFoodLogUpdateBody, parseFoodSearchParams } from './foodUtils';
import { diagnosticsRegistry, safeErrorType } from '../observability';
import {
    getRecentFoodSuggestions,
    RECENT_FOOD_DEFAULT_LIMIT,
    RECENT_FOOD_MAX_LIMIT
} from '../services/recentFoods';
import { getFoodDayWriteBlock } from '../services/foodTracking';
import {
    copyFoodLogs,
    foodCopyOperationPayload,
    parseFoodCopyRequest
} from '../services/foodCopy';
import { getAuthenticatedUser, requireAuthenticatedUser } from '../middleware/authenticatedUser';

/**
 * Food log and food search endpoints.
 *
 * Logs are stored with a local-date column so day grouping respects the user's timezone.
 */
const router = express.Router();

type ProviderSearchAttempt = {
    name: FoodDataSource;
    status: 'skipped' | 'error' | 'empty';
    detail?: string;
};

type ProviderSearchOutcome =
    | {
          found: true;
          provider: FoodDataProvider;
          result: FoodSearchResult;
          attempts: ProviderSearchAttempt[];
      }
    | {
          found: false;
          attempts: ProviderSearchAttempt[];
          sawSuccessfulResponse: boolean;
          lastError: Error | null;
      };

/**
 * Summarize provider search attempts for logs without leaking request details.
 */
const formatProviderAttemptSummary = (attempts: ProviderSearchAttempt[]): string => {
    return attempts
        .map((attempt) => `${attempt.name} (${attempt.status})`)
        .join(', ');
};

/**
 * Search ready providers in configured order, stopping at the first usable provider response.
 */
const searchEnabledProviders = async (
    params: FoodSearchRequest,
    opts: { fallbackOnEmpty: boolean; requireBarcodeLookup: boolean }
): Promise<ProviderSearchOutcome> => {
    const { primary, providers } = getEnabledFoodDataProviders();
    const attempts: ProviderSearchAttempt[] = [];

    if (!primary.ready) {
        attempts.push({
            name: primary.name,
            status: 'skipped',
            detail: primary.detail || 'Provider is not ready.'
        });
    }

    let sawSuccessfulResponse = false;
    let lastError: Error | null = null;

    for (const providerInfo of providers) {
        if (opts.requireBarcodeLookup && !providerInfo.supportsBarcodeLookup) {
            attempts.push({
                name: providerInfo.name,
                status: 'skipped',
                detail: 'Barcode lookup is disabled for this provider.'
            });
            continue;
        }

        const resolution = getFoodDataProviderByName(providerInfo.name);
        if (!resolution.provider) {
            attempts.push({
                name: providerInfo.name,
                status: 'skipped',
                detail: resolution.error || providerInfo.detail || 'Provider is not available.'
            });
            continue;
        }

        if (opts.requireBarcodeLookup && !resolution.provider.supportsBarcodeLookup) {
            attempts.push({
                name: providerInfo.name,
                status: 'skipped',
                detail: 'Barcode lookup is disabled for this provider.'
            });
            continue;
        }

        const startedAt = Date.now();
        try {
            const result = await resolution.provider.searchFoods(params);
            diagnosticsRegistry.recordOperation(
                'food_provider_request',
                result.items.length > 0 ? 'success' : 'empty',
                Date.now() - startedAt
            );
            // A provider may disable barcode support after an upstream scope error during this request.
            if (opts.requireBarcodeLookup && !resolution.provider.supportsBarcodeLookup) {
                attempts.push({
                    name: providerInfo.name,
                    status: 'skipped',
                    detail: 'Barcode lookup is disabled for this provider.'
                });
                continue;
            }

            sawSuccessfulResponse = true;
            if (result.items.length > 0 || !opts.fallbackOnEmpty) {
                return {
                    found: true,
                    provider: resolution.provider,
                    result,
                    attempts
                };
            }

            attempts.push({ name: providerInfo.name, status: 'empty' });
        } catch (err) {
            diagnosticsRegistry.recordOperation('food_provider_request', 'failure', Date.now() - startedAt);
            const message = err instanceof Error ? err.message : 'Search failed.';
            attempts.push({ name: providerInfo.name, status: 'error', detail: message });
            lastError = err instanceof Error ? err : new Error(message);
        }
    }

    return { found: false, attempts, sawSuccessfulResponse, lastError };
};

router.use(requireAuthenticatedUser);

router.get('/recent', async (req, res) => {
    const user = getAuthenticatedUser(req);
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    const limitRaw = parsePositiveInteger(req.query.limit);
    const limit =
        limitRaw !== null
            ? Math.min(Math.max(limitRaw, 1), RECENT_FOOD_MAX_LIMIT)
            : RECENT_FOOD_DEFAULT_LIMIT;
    const mealPeriodRaw = req.query.meal_period;
    const mealPeriod = mealPeriodRaw === undefined ? undefined : parseMealPeriod(mealPeriodRaw);
    if (mealPeriodRaw !== undefined && mealPeriod === null) {
        return res.status(400).json({ message: 'Invalid meal period' });
    }

    try {
        const items = await getRecentFoodSuggestions({
            userId: user.id,
            limit,
            query: q,
            mealPeriod: mealPeriod ?? undefined,
            database: prisma
        });
        return res.json({ items });
    } catch (err) {
        const errorType = safeErrorType(err);
        console.error(`Food lookup failed (request_id=${res.locals?.requestId ?? 'unavailable'}, error_type=${errorType}).`);
        return res.status(500).json({ message: 'Server error' });
    }
});

router.get('/search', async (req, res) => {
    // Parse query params once so providers can remain agnostic to Express and raw query types.
    const parsed = parseFoodSearchParams({
        query: req.query as Record<string, unknown>,
        acceptLanguageHeader: req.headers['accept-language']
    });

    if (!parsed.ok) {
        return res.status(parsed.statusCode).json({ message: parsed.message });
    }

    const searchOutcome = await searchEnabledProviders(parsed.params, {
        fallbackOnEmpty: Boolean(parsed.params.barcode),
        requireBarcodeLookup: Boolean(parsed.params.barcode)
    });

    if (searchOutcome.found) {
        return res.json({
            provider: searchOutcome.provider.name,
            supportsBarcodeLookup: searchOutcome.provider.supportsBarcodeLookup,
            ...searchOutcome.result
        });
    }

    if (!searchOutcome.sawSuccessfulResponse && searchOutcome.lastError) {
        const errorType = safeErrorType(searchOutcome.lastError);
        console.error(`Food provider search failed (request_id=${res.locals?.requestId ?? 'unavailable'}, error_type=${errorType}).`);
        if (searchOutcome.attempts.length > 0) {
            console.info(
                `Food search failed for all providers. Attempts: ${formatProviderAttemptSummary(searchOutcome.attempts)}`
            );
        }
        return res.status(500).json({ message: 'Unable to search foods right now.' });
    }

    if (searchOutcome.attempts.length > 0) {
        console.info(
            `Food search returned no results. Attempts: ${formatProviderAttemptSummary(searchOutcome.attempts)}`
        );
    }

    return res.json({ items: [] });
});

router.get('/', async (req, res) => {
    const user = getAuthenticatedUser(req);
    const dateParam = typeof req.query.date === 'string' ? req.query.date : undefined;
    const localDateParam = typeof req.query.local_date === 'string' ? req.query.local_date : undefined;
    const requestedDate = localDateParam ?? dateParam;

    const whereClause: Prisma.FoodLogWhereInput = { user_id: user.id };
    if (requestedDate !== undefined) {
        try {
            // Treat date strings as local-date values (no timezone math).
            whereClause.local_date = parseLocalDateOnly(requestedDate);
        } catch {
            return res.status(400).json({ message: 'Invalid date' });
        }
    }

    try {
        const logs = await prisma.foodLog.findMany({
            where: whereClause,
            orderBy: { created_at: 'asc' }
        });
        res.json(logs);
    } catch (err) {
        res.status(500).json({ message: 'Server error' });
    }
});

router.post('/', async (req, res) => {
    const user = getAuthenticatedUser(req);
    try {
        const operationId = parseClientOperationId(
            req.get?.('x-client-operation-id') ?? req.headers?.['x-client-operation-id']
        );
        if (operationId === null) {
            return res.status(400).json({ message: 'Invalid x-client-operation-id' });
        }

        // Supports either manual entries or a "my food" reference with servings.
        const parsedBody = parseFoodLogCreateBody({
            body: req.body,
            userTimeZone: user.timezone
        });

        if (!parsedBody.ok) {
            return res.status(parsedBody.statusCode).json({ message: parsedBody.message });
        }

        const result = await executeIdempotentMutation<unknown>({
            userId: user.id,
            operationId,
            operationKind: 'food_log.create',
            requestPayload: req.body,
            mutate: async (tx, claimedOperationId) => {
                await observeFoodActivityPlan(tx, user.id, [parsedBody.localDate]);
                const writeBlock = await getFoodDayWriteBlock({
                    userId: user.id,
                    localDate: parsedBody.localDate,
                    db: tx
                });
                if (writeBlock) return writeBlock;

                if (parsedBody.kind === 'MY_FOOD') {
                    // Snapshot serving details so later edits to "my foods" do not mutate historical logs.
                    const myFood = await tx.myFood.findFirst({
                        where: { id: parsedBody.myFoodId, user_id: user.id }
                    });
                    if (!myFood) {
                        return { status: 404, body: { message: 'My food not found' } };
                    }

                    const caloriesTotal = Math.round(parsedBody.servingsConsumed * myFood.calories_per_serving);
                    const log = await tx.foodLog.create({
                        data: {
                            user_id: user.id,
                            my_food_id: myFood.id,
                            name: myFood.name,
                            calories: caloriesTotal,
                            meal_period: parsedBody.mealPeriod,
                            date: parsedBody.entryTimestamp,
                            local_date: parsedBody.localDate,
                            servings_consumed: parsedBody.servingsConsumed,
                            serving_size_quantity_snapshot: myFood.serving_size_quantity,
                            serving_unit_label_snapshot: myFood.serving_unit_label,
                            calories_per_serving_snapshot: myFood.calories_per_serving
                        }
                    });
                    await recordSyncChange({
                        tx,
                        userId: user.id,
                        entityType: 'food_log',
                        entityId: log.id,
                        action: 'upsert',
                        operationId: claimedOperationId,
                        payload: log
                    });
                    return { status: 200, body: log };
                }

                const log = await tx.foodLog.create({
                    data: {
                        user_id: user.id,
                        name: parsedBody.name,
                        calories: parsedBody.calories,
                        meal_period: parsedBody.mealPeriod,
                        date: parsedBody.entryTimestamp,
                        local_date: parsedBody.localDate,
                        servings_consumed: parsedBody.servingsConsumed,
                        serving_size_quantity_snapshot: parsedBody.servingSizeQuantitySnapshot,
                        serving_unit_label_snapshot: parsedBody.servingUnitLabelSnapshot,
                        calories_per_serving_snapshot: parsedBody.caloriesPerServingSnapshot,
                        external_source: parsedBody.externalSource,
                        external_id: parsedBody.externalId,
                        brand_snapshot: parsedBody.brandSnapshot,
                        locale_snapshot: parsedBody.localeSnapshot,
                        barcode_snapshot: parsedBody.barcodeSnapshot,
                        measure_label_snapshot: parsedBody.measureLabelSnapshot,
                        grams_per_measure_snapshot: parsedBody.gramsPerMeasureSnapshot,
                        measure_quantity_snapshot: parsedBody.measureQuantitySnapshot,
                        grams_total_snapshot: parsedBody.gramsTotalSnapshot
                    }
                });
                await recordSyncChange({
                    tx,
                    userId: user.id,
                    entityType: 'food_log',
                    entityId: log.id,
                    action: 'upsert',
                    operationId: claimedOperationId,
                    payload: log
                });
                return { status: 200, body: log };
            }
        });

        return res.status(result.status).json(result.body);
    } catch (err) {
        if (err instanceof ClientOperationConflictError) {
            return res.status(409).json({
                message: err.message,
                code: err.code,
                retryable: err.code === 'OPERATION_IN_PROGRESS'
            });
        }
        res.status(500).json({ message: 'Server error' });
    }
});

router.post('/copy', async (req, res) => {
    const user = getAuthenticatedUser(req);
    const parsedCopy = parseFoodCopyRequest({
        body: req.body,
        userTimeZone: user.timezone
    });
    if (!parsedCopy.ok) {
        return res.status(parsedCopy.statusCode).json({
            message: parsedCopy.message,
            code: 'INVALID_FOOD_COPY',
            retryable: false
        });
    }

    try {
        const result = await executeIdempotentMutation<unknown>({
            userId: user.id,
            operationId: parsedCopy.request.operationId,
            operationKind: 'food_log.copy',
            requestPayload: foodCopyOperationPayload(parsedCopy.request),
            mutate: (tx, claimedOperationId) => copyFoodLogs({
                tx,
                userId: user.id,
                request: parsedCopy.request,
                operationId: claimedOperationId ?? parsedCopy.request.operationId
            })
        });
        return res.status(result.status).json(result.body);
    } catch (err) {
        if (err instanceof ClientOperationConflictError) {
            return res.status(409).json({
                message: err.message,
                code: err.code,
                retryable: err.code === 'OPERATION_IN_PROGRESS'
            });
        }
        return res.status(500).json({ message: 'Server error' });
    }
});

router.patch('/:id', async (req, res) => {
    const user = getAuthenticatedUser(req);
    const id = parsePositiveInteger(req.params.id);
    if (id === null) {
        return res.status(400).json({ message: 'Invalid food log id' });
    }

    try {
        const operationId = parseClientOperationId(
            req.get?.('x-client-operation-id') ?? req.headers?.['x-client-operation-id']
        );
        if (operationId === null) {
            return res.status(400).json({ message: 'Invalid x-client-operation-id' });
        }

        const existing = await prisma.foodLog.findFirst({ where: { id, user_id: user.id } });
        if (!existing) {
            return res.status(404).json({ message: 'Food log not found' });
        }
        const parsedUpdate = parseFoodLogUpdateBody({ body: req.body, existing });
        if (!parsedUpdate.ok) {
            return res.status(parsedUpdate.statusCode).json({ message: parsedUpdate.message });
        }

        const result = await executeIdempotentMutation<unknown>({
            userId: user.id,
            operationId,
            operationKind: 'food_log.update',
            requestPayload: { id, ...req.body },
            mutate: async (tx, claimedOperationId) => {
                await observeFoodActivityPlan(tx, user.id, [existing.local_date]);
                const updated = await tx.foodLog.update({
                    where: { id },
                    data: parsedUpdate.updateData
                });
                await recordSyncChange({
                    tx,
                    userId: user.id,
                    entityType: 'food_log',
                    entityId: id,
                    action: 'upsert',
                    operationId: claimedOperationId,
                    payload: updated
                });
                return { status: 200, body: updated };
            }
        });

        return res.status(result.status).json(result.body);
    } catch (err) {
        if (err instanceof ClientOperationConflictError) {
            return res.status(409).json({
                message: err.message,
                code: err.code,
                retryable: err.code === 'OPERATION_IN_PROGRESS'
            });
        }
        res.status(500).json({ message: 'Server error' });
    }
});

router.delete('/:id', async (req, res) => {
    const user = getAuthenticatedUser(req);
    const id = parsePositiveInteger(req.params.id);
    if (id === null) {
        return res.status(400).json({ message: 'Invalid food log id' });
    }

    try {
        const operationId = parseClientOperationId(
            req.get?.('x-client-operation-id') ?? req.headers?.['x-client-operation-id']
        );
        if (operationId === null) {
            return res.status(400).json({ message: 'Invalid x-client-operation-id' });
        }

        const result = await executeIdempotentMutation<unknown>({
            userId: user.id,
            operationId,
            operationKind: 'food_log.delete',
            requestPayload: { id },
            mutate: async (tx, claimedOperationId) => {
                await lockCaloriePlanningInputs(tx, user.id);
                const existing = await tx.foodLog.findFirst({ where: { id, user_id: user.id } });
                if (existing) await observeFoodActivityPlan(tx, user.id, [existing.local_date]);
                const deleteResult = await tx.foodLog.deleteMany({ where: { id, user_id: user.id } });
                if (deleteResult.count > 0) await recordSyncChange({
                    tx,
                    userId: user.id,
                    entityType: 'food_log',
                    entityId: id,
                    action: 'delete',
                    operationId: claimedOperationId
                });
                return { status: 204, body: null };
            }
        });

        if (result.status === 204) return res.status(204).send();
        return res.status(result.status).json(result.body);
    } catch (err) {
        if (err instanceof ClientOperationConflictError) {
            return res.status(409).json({
                message: err.message,
                code: err.code,
                retryable: err.code === 'OPERATION_IN_PROGRESS'
            });
        }
        res.status(500).json({ message: 'Server error' });
    }
});

export default router;
