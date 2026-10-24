/** @file Development-only helpers for the explicitly enabled seeded-account workflow. */

import express from 'express';
import { InAppNotificationType } from '@prisma/client';
import prisma from '../config/database';
import {
    getFoodDataProviderByName,
    listFoodDataProviders,
    type FoodDataProviderInfo,
    type FoodDataSource,
    type FoodSearchRequest
} from '../services/foodData';
import { buildReminderPayload, type PushNotificationPayload } from '../services/pushNotificationPayloads';
import {
    DEFAULT_NOTIFICATION_DELIVERY_CHANNELS,
    NOTIFICATION_DELIVERY_CHANNELS,
    parseNotificationDeliveryChannels,
    type NotificationDeliveryChannel
} from '../../../shared/notificationDelivery';
import { buildDevReminderInAppDedupeKey } from '../services/inAppNotifications';
import { getSafeUtcTodayDateOnlyInTimeZone } from '../utils/date';
import { deliverUserNotification, type DeliverUserNotificationResult } from '../services/notificationDelivery';
import { publishNotificationRealtimeUpdate } from '../services/notificationRealtime';
import { NOTIFICATION_REALTIME_REASONS } from '../../../shared/notificationRealtime';
import {
    getAuthenticatedUser,
    requireAuthenticatedUser,
    type AuthenticatedUser
} from '../middleware/authenticatedUser';

/**
 * Dev-only endpoints for food provider diagnostics and comparisons.
 */
const router = express.Router();

/**
 * Normalize query parameters into a single search request for provider comparisons.
 */
const buildSearchRequest = (req: express.Request): FoodSearchRequest => {
    const query = (req.query.q as string) || (req.query.query as string);
    const barcode = typeof req.query.barcode === 'string' ? req.query.barcode : undefined;
    const page = typeof req.query.page === 'string' ? parseInt(req.query.page, 10) : undefined;
    const pageSize = typeof req.query.pageSize === 'string' ? parseInt(req.query.pageSize, 10) : undefined;
    const quantityInGrams = typeof req.query.grams === 'string' ? parseFloat(req.query.grams) : undefined;
    const includeIncompleteParam = typeof req.query.includeIncomplete === 'string' ? req.query.includeIncomplete : undefined;
    const includeIncomplete = includeIncompleteParam
        ? ['true', '1', 'yes'].includes(includeIncompleteParam.toLowerCase())
        : true;
    const rawLanguage = typeof req.query.lc === 'string' ? req.query.lc.trim().toLowerCase() : undefined;
    const headerLanguage =
        typeof req.headers['accept-language'] === 'string'
            ? req.headers['accept-language'].split(',')[0]?.trim().split('-')[0]?.toLowerCase()
            : undefined;
    const languageCode = rawLanguage || headerLanguage;

    return {
        query: query?.trim() ? query.trim() : undefined,
        barcode,
        page,
        pageSize,
        quantityInGrams,
        includeIncomplete,
        languageCode
    };
};

/**
 * Resolve which providers to query so the dev UI can default to ready providers.
 */
const resolveRequestedProviders = (req: express.Request, available: FoodDataProviderInfo[]): FoodDataSource[] => {
    const requestedParam = typeof req.query.providers === 'string' ? req.query.providers : undefined;
    const readyProviders = available.filter((provider) => provider.ready).map((provider) => provider.name);

    if (!requestedParam) {
        return readyProviders;
    }

    const availableNames = new Set(available.map((provider) => provider.name));
    const requested = requestedParam
        .split(',')
        .map((name) => name.trim())
        .filter((name) => Boolean(name))
        .filter((name): name is FoodDataSource => availableNames.has(name as FoodDataSource));

    return requested.length ? requested : readyProviders;
};

const DEV_NOTIFICATION_TYPES = {
    TEST: 'test',
    LOG_WEIGHT: 'log_weight',
    LOG_FOOD: 'log_food'
} as const;

type DevNotificationType = (typeof DEV_NOTIFICATION_TYPES)[keyof typeof DEV_NOTIFICATION_TYPES];

type DevNotificationClearRequestBody = {
    type?: unknown;
    endpoint?: unknown;
    clear_push_subscription?: unknown;
    clear_push_delivery?: unknown;
    clear_in_app?: unknown;
};

const DEV_NOTIFICATION_TYPE_VALUES = new Set<string>(Object.values(DEV_NOTIFICATION_TYPES));

const resolveSingleValue = (value: unknown): string | null => {
    if (typeof value === 'string') {
        return value;
    }

    if (Array.isArray(value)) {
        const [first] = value;
        return typeof first === 'string' ? first : null;
    }

    return null;
};

/**
 * Parse a dev notification type from query/body input.
 */
const parseDevNotificationType = (value: unknown): DevNotificationType | null => {
    const rawValue = resolveSingleValue(value);
    if (!rawValue) {
        return null;
    }

    const normalized = rawValue.trim().toLowerCase();
    if (!DEV_NOTIFICATION_TYPE_VALUES.has(normalized)) {
        return null;
    }

    return normalized as DevNotificationType;
};

/**
 * Read an endpoint from the request body so dev sends can target the current browser only.
 */
const resolvePushEndpoint = (body: unknown): string => {
    if (!body || typeof body !== 'object') {
        return '';
    }
    const endpoint = (body as { endpoint?: unknown }).endpoint;
    return typeof endpoint === 'string' ? endpoint.trim() : '';
};

const resolvePushEndpointFromQuery = (query: express.Request['query']): string => {
    const endpoint = resolveSingleValue(query.endpoint);
    return endpoint ? endpoint.trim() : '';
};

/**
 * Parse requested delivery channels, defaulting to both when the body omits channel selection.
 */
const resolveRequestedChannels = (body: unknown): NotificationDeliveryChannel[] => {
    if (!body || typeof body !== 'object') {
        return [...DEFAULT_NOTIFICATION_DELIVERY_CHANNELS];
    }

    const rawChannels = (body as { channels?: unknown }).channels;
    if (rawChannels === undefined) {
        return [...DEFAULT_NOTIFICATION_DELIVERY_CHANNELS];
    }

    return parseNotificationDeliveryChannels(rawChannels);
};

const shouldRequirePushEndpoint = (channels: NotificationDeliveryChannel[]): boolean => {
    return channels.includes(NOTIFICATION_DELIVERY_CHANNELS.PUSH);
};

const buildDeliveryResponse = (
    channels: NotificationDeliveryChannel[],
    result: DeliverUserNotificationResult
) => {
    const pushSelected = channels.includes(NOTIFICATION_DELIVERY_CHANNELS.PUSH);
    const inAppSelected = channels.includes(NOTIFICATION_DELIVERY_CHANNELS.IN_APP);

    const pushSucceeded = !pushSelected || result.push.sent > 0 || result.push.deduped;
    const inAppSucceeded = !inAppSelected || result.inApp.created > 0 || result.inApp.deduped;

    const ok = pushSucceeded && inAppSucceeded;
    const partial =
        !ok &&
        ((pushSelected && (result.push.sent > 0 || result.push.deduped)) ||
            (inAppSelected && (result.inApp.created > 0 || result.inApp.deduped)));

    return {
        ok,
        partial,
        channels,
        push: result.push,
        in_app: result.inApp
    };
};

const getUserLocalDate = (user: AuthenticatedUser, now = new Date()): Date => {
    return getSafeUtcTodayDateOnlyInTimeZone(user.timezone || 'UTC', now);
};

const formatUtcDateOnly = (value: Date): string => value.toISOString().slice(0, 10);

const isSameUtcDate = (left: Date | null | undefined, right: Date): boolean => {
    if (!left) {
        return false;
    }

    return left.getTime() === right.getTime();
};

const resolveInAppNotificationType = (notificationType: DevNotificationType): InAppNotificationType => {
    switch (notificationType) {
        case DEV_NOTIFICATION_TYPES.LOG_WEIGHT:
            return InAppNotificationType.LOG_WEIGHT_REMINDER;
        case DEV_NOTIFICATION_TYPES.LOG_FOOD:
            return InAppNotificationType.LOG_FOOD_REMINDER;
        default:
            return InAppNotificationType.GENERIC;
    }
};

const supportsReminderDedupe = (notificationType: DevNotificationType): boolean => {
    return notificationType !== DEV_NOTIFICATION_TYPES.TEST;
};

router.get('/food/providers', (_req, res) => {
    res.json({ providers: listFoodDataProviders() });
});

router.get('/food/search', async (req, res) => {
    const searchRequest = buildSearchRequest(req);
    if (!searchRequest.query && !searchRequest.barcode) {
        return res.status(400).json({ message: 'Provide a search query or barcode.' });
    }

    const providers = listFoodDataProviders();
    const selectedProviders = resolveRequestedProviders(req, providers);
    if (selectedProviders.length === 0) {
        return res.status(400).json({ message: 'No providers are configured for search.' });
    }

    const results = await Promise.all(
        selectedProviders.map(async (name) => {
            const providerInfo = providers.find((provider) => provider.name === name);
            if (!providerInfo) {
                return {
                    name,
                    label: name,
                    supportsBarcodeLookup: false,
                    ready: false,
                    items: [],
                    error: 'Provider metadata missing.'
                };
            }

            if (!providerInfo.ready) {
                return {
                    ...providerInfo,
                    items: [],
                    error: providerInfo.detail || 'Provider is not ready.'
                };
            }

            const resolution = getFoodDataProviderByName(name);
            if (!resolution.provider) {
                return {
                    ...providerInfo,
                    items: [],
                    error: resolution.error || 'Provider is not available.'
                };
            }

            const startedAt = Date.now();
            try {
                const searchResult = await resolution.provider.searchFoods(searchRequest);
                return {
                    ...providerInfo,
                    items: searchResult.items,
                    elapsedMs: Date.now() - startedAt
                };
            } catch (error) {
                console.error(`Dev provider search failed for ${name}:`, error);
                return {
                    ...providerInfo,
                    items: [],
                    elapsedMs: Date.now() - startedAt,
                    error: error instanceof Error ? error.message : 'Search failed.'
                };
            }
        })
    );

    res.json({
        query: searchRequest.query,
        barcode: searchRequest.barcode,
        results
    });
});

router.get('/notifications/status', requireAuthenticatedUser, async (req, res) => {
    const user = getAuthenticatedUser(req);
    const notificationType = parseDevNotificationType(req.query.type);
    if (!notificationType) {
        return res.status(400).json({
            message: 'Invalid notification type. Use test, log_weight, or log_food.'
        });
    }

    const endpoint = resolvePushEndpointFromQuery(req.query);
    const localDate = getUserLocalDate(user);
    const localDateLabel = formatUtcDateOnly(localDate);
    const inAppType = resolveInAppNotificationType(notificationType);
    const usesReminderDedupe = supportsReminderDedupe(notificationType);
    const inAppDedupeKey = usesReminderDedupe ? buildDevReminderInAppDedupeKey(inAppType, localDate) : null;
    const pushScope = endpoint ? { user_id: user.id, endpoint } : { user_id: user.id };

    const [totalSubscriptionCount, scopedSubscriptions, inAppRows] = await Promise.all([
        prisma.pushSubscription.count({
            where: {
                user_id: user.id
            }
        }),
        prisma.pushSubscription.findMany({
            where: pushScope,
            select: {
                endpoint: true,
                last_sent_local_date: true
            }
        }),
        prisma.inAppNotification.findMany({
            where: {
                user_id: user.id,
                type: inAppType,
                local_date: localDate
            },
            select: {
                dedupe_key: true,
                read_at: true,
                dismissed_at: true,
                resolved_at: true
            }
        })
    ]);

    const deliveredSubscriptionCount = scopedSubscriptions.filter((subscription) =>
        isSameUtcDate(subscription.last_sent_local_date, localDate)
    ).length;
    const matchingSubscriptionCount = scopedSubscriptions.length;
    const latestLastSentLocalDate = scopedSubscriptions.reduce<Date | null>((latest, subscription) => {
        if (!(subscription.last_sent_local_date instanceof Date)) {
            return latest;
        }
        if (!latest || subscription.last_sent_local_date.getTime() > latest.getTime()) {
            return subscription.last_sent_local_date;
        }
        return latest;
    }, null);

    const inAppTodayTotalCount = inAppRows.length;
    const inAppTodayActiveCount = inAppRows.filter(
        (row) => row.dismissed_at === null && row.resolved_at === null
    ).length;
    const inAppTodayReadCount = inAppRows.filter((row) => row.read_at instanceof Date).length;
    const inAppTodayDismissedCount = inAppRows.filter((row) => row.dismissed_at instanceof Date).length;
    const inAppTodayResolvedCount = inAppRows.filter((row) => row.resolved_at instanceof Date).length;
    const inAppDedupedForLocalDay =
        usesReminderDedupe && Boolean(inAppDedupeKey) && inAppRows.some((row) => row.dedupe_key === inAppDedupeKey);

    res.json({
        notification_type: notificationType,
        local_date: localDateLabel,
        push: {
            endpoint: endpoint || null,
            total_subscription_count: totalSubscriptionCount,
            matching_subscription_count: matchingSubscriptionCount,
            delivery_dedupe_applies: usesReminderDedupe,
            delivered_subscription_count: deliveredSubscriptionCount,
            delivered_for_local_day:
                usesReminderDedupe && matchingSubscriptionCount > 0 && deliveredSubscriptionCount === matchingSubscriptionCount,
            last_sent_local_date: latestLastSentLocalDate ? formatUtcDateOnly(latestLastSentLocalDate) : null
        },
        in_app: {
            type: inAppType,
            dedupe_key: inAppDedupeKey,
            delivery_dedupe_applies: usesReminderDedupe,
            deduped_for_local_day: inAppDedupedForLocalDay,
            today_total_count: inAppTodayTotalCount,
            today_active_count: inAppTodayActiveCount,
            today_read_count: inAppTodayReadCount,
            today_dismissed_count: inAppTodayDismissedCount,
            today_resolved_count: inAppTodayResolvedCount
        }
    });
});

router.post('/notifications/clear', requireAuthenticatedUser, async (req, res) => {
    const user = getAuthenticatedUser(req);
    const body = (req.body ?? {}) as DevNotificationClearRequestBody;
    const notificationType = parseDevNotificationType(body.type);
    if (!notificationType) {
        return res.status(400).json({
            message: 'Invalid notification type. Use test, log_weight, or log_food.'
        });
    }

    const clearPushSubscription = body.clear_push_subscription === true;
    const clearPushDelivery = body.clear_push_delivery === true;
    const clearInApp = body.clear_in_app === true;
    if (!clearPushSubscription && !clearPushDelivery && !clearInApp) {
        return res.status(400).json({
            message: 'Select at least one notification state to clear.'
        });
    }

    const endpoint = resolvePushEndpoint(body);
    const localDate = getUserLocalDate(user);
    const localDateLabel = formatUtcDateOnly(localDate);
    const inAppType = resolveInAppNotificationType(notificationType);
    const usesReminderDedupe = supportsReminderDedupe(notificationType);
    const inAppDedupeKey = usesReminderDedupe ? buildDevReminderInAppDedupeKey(inAppType, localDate) : null;
    const pushScope = endpoint ? { user_id: user.id, endpoint } : { user_id: user.id };

    let clearedPushSubscriptionCount = 0;
    let clearedPushDeliveryCount = 0;
    let clearedInAppCount = 0;

    if (clearPushSubscription) {
        const result = await prisma.pushSubscription.deleteMany({
            where: pushScope
        });
        clearedPushSubscriptionCount = result.count;
    }

    if (clearPushDelivery) {
        const result = await prisma.pushSubscription.updateMany({
            where: pushScope,
            data: {
                last_sent_local_date: null
            }
        });
        clearedPushDeliveryCount = result.count;
    }

    if (clearInApp) {
        const result = inAppDedupeKey
            ? await prisma.inAppNotification.deleteMany({
                  where: {
                      user_id: user.id,
                      OR: [{ dedupe_key: inAppDedupeKey }, { type: inAppType, local_date: localDate }]
                  }
              })
            : await prisma.inAppNotification.deleteMany({
                  where: {
                      user_id: user.id,
                      type: inAppType,
                      local_date: localDate
                  }
              });
        clearedInAppCount = result.count;
    }

    if (clearedInAppCount > 0) {
        publishNotificationRealtimeUpdate({
            userId: user.id,
            reason: NOTIFICATION_REALTIME_REASONS.CLEARED
        });
    }

    res.json({
        ok: true,
        notification_type: notificationType,
        local_date: localDateLabel,
        cleared: {
            push_subscription: clearedPushSubscriptionCount,
            push_delivery: clearedPushDeliveryCount,
            in_app: clearedInAppCount
        }
    });
});

router.post('/notifications/test', requireAuthenticatedUser, async (req, res) => {
    const user = getAuthenticatedUser(req);
    const channels = resolveRequestedChannels(req.body);
    if (channels.length === 0) {
        return res.status(400).json({ message: 'Select at least one notification channel.' });
    }

    const endpoint = resolvePushEndpoint(req.body);
    if (shouldRequirePushEndpoint(channels) && !endpoint) {
        return res.status(400).json({ message: 'Endpoint is required when push delivery is selected.' });
    }

    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    const localDate = getUserLocalDate(user);

    const payload: PushNotificationPayload = {
        title: title || 'calibrate',
        body: body || 'This is a test notification.',
        url: url || '/'
    };

    const result = await deliverUserNotification({
        userId: user.id,
        channels,
        push: {
            payload,
            endpoint
        },
        inApp: {
            type: InAppNotificationType.GENERIC,
            localDate,
            title: payload.title,
            body: payload.body,
            actionUrl: payload.url
        }
    });

    res.json(buildDeliveryResponse(channels, result));
});

router.post('/notifications/log-weight', requireAuthenticatedUser, async (req, res) => {
    const user = getAuthenticatedUser(req);
    const channels = resolveRequestedChannels(req.body);
    if (channels.length === 0) {
        return res.status(400).json({ message: 'Select at least one notification channel.' });
    }

    const endpoint = resolvePushEndpoint(req.body);
    if (shouldRequirePushEndpoint(channels) && !endpoint) {
        return res.status(400).json({ message: 'Endpoint is required when push delivery is selected.' });
    }

    const localDate = getUserLocalDate(user);
    const dedupeKey = buildDevReminderInAppDedupeKey(InAppNotificationType.LOG_WEIGHT_REMINDER, localDate);
    const payload = buildReminderPayload({ missingWeight: true, missingFood: false });
    const result = await deliverUserNotification({
        userId: user.id,
        channels,
        push: {
            payload,
            endpoint,
            skipIfLastSentLocalDate: localDate,
            markSentLocalDate: localDate
        },
        inApp: {
            type: InAppNotificationType.LOG_WEIGHT_REMINDER,
            localDate,
            dedupeKey
        }
    });

    res.json(buildDeliveryResponse(channels, result));
});

router.post('/notifications/log-food', requireAuthenticatedUser, async (req, res) => {
    const user = getAuthenticatedUser(req);
    const channels = resolveRequestedChannels(req.body);
    if (channels.length === 0) {
        return res.status(400).json({ message: 'Select at least one notification channel.' });
    }

    const endpoint = resolvePushEndpoint(req.body);
    if (shouldRequirePushEndpoint(channels) && !endpoint) {
        return res.status(400).json({ message: 'Endpoint is required when push delivery is selected.' });
    }

    const localDate = getUserLocalDate(user);
    const dedupeKey = buildDevReminderInAppDedupeKey(InAppNotificationType.LOG_FOOD_REMINDER, localDate);
    const payload = buildReminderPayload({ missingWeight: false, missingFood: true });
    const result = await deliverUserNotification({
        userId: user.id,
        channels,
        push: {
            payload,
            endpoint,
            skipIfLastSentLocalDate: localDate,
            markSentLocalDate: localDate
        },
        inApp: {
            type: InAppNotificationType.LOG_FOOD_REMINDER,
            localDate,
            dedupeKey
        }
    });

    res.json(buildDeliveryResponse(channels, result));
});

export default router;
