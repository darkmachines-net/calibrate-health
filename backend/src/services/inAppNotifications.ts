/** @file Durable in-app notification creation, deduplication, account ownership, and read/dismiss lifecycle. */

import { InAppNotificationType, Prisma } from '@prisma/client';
import prisma from '../config/database';
import { getSafeUtcTodayDateOnlyInTimeZone } from '../utils/date';
import { IN_APP_NOTIFICATION_ACTION_URLS, IN_APP_NOTIFICATION_TYPES, type InAppNotificationType as SharedInAppNotificationType } from '../../../shared/inAppNotifications';
import { NOTIFICATION_REALTIME_REASONS } from '../../../shared/notificationRealtime';
import { publishNotificationRealtimeUpdate } from './notificationRealtime';

const REMINDER_TYPES: readonly InAppNotificationType[] = [
    InAppNotificationType.LOG_WEIGHT_REMINDER,
    InAppNotificationType.LOG_FOOD_REMINDER
] as const;
const DEV_REMINDER_DEDUPE_KEY_PREFIX = 'dev:reminder:';
const IN_APP_NOTIFICATION_CURSOR_VERSION = 1;

export const IN_APP_NOTIFICATION_VIEWS = {
    ACTIVE: 'active',
    HISTORY: 'history'
} as const;
export const DEFAULT_IN_APP_NOTIFICATION_PAGE_LIMIT = 20;
export const MAX_IN_APP_NOTIFICATION_PAGE_LIMIT = 100;

export type InAppNotificationView =
    (typeof IN_APP_NOTIFICATION_VIEWS)[keyof typeof IN_APP_NOTIFICATION_VIEWS];

const ACTION_URL_BY_TYPE: Record<InAppNotificationType, string> = {
    [InAppNotificationType.LOG_WEIGHT_REMINDER]:
        IN_APP_NOTIFICATION_ACTION_URLS[IN_APP_NOTIFICATION_TYPES.LOG_WEIGHT_REMINDER],
    [InAppNotificationType.LOG_FOOD_REMINDER]:
        IN_APP_NOTIFICATION_ACTION_URLS[IN_APP_NOTIFICATION_TYPES.LOG_FOOD_REMINDER],
    [InAppNotificationType.GENERIC]:
        IN_APP_NOTIFICATION_ACTION_URLS[IN_APP_NOTIFICATION_TYPES.GENERIC]
};

type InAppNotificationClient = {
    inAppNotification: {
        findMany: typeof prisma.inAppNotification.findMany;
        updateMany: typeof prisma.inAppNotification.updateMany;
    };
    foodLog: {
        count: typeof prisma.foodLog.count;
    };
    bodyMetric: {
        count: typeof prisma.bodyMetric.count;
    };
    foodLogDay?: {
        findUnique: typeof prisma.foodLogDay.findUnique;
    };
    foodTrackingPause?: {
        findFirst: typeof prisma.foodTrackingPause.findFirst;
    };
};

type InAppNotificationPageClient = Omit<InAppNotificationClient, 'inAppNotification'> & {
    inAppNotification: InAppNotificationClient['inAppNotification'] & {
        count: typeof prisma.inAppNotification.count;
    };
};

export type InAppNotificationWire = {
    id: number;
    type: SharedInAppNotificationType;
    local_date: string;
    created_at: string;
    read_at: string | null;
    title: string | null;
    body: string | null;
    action_url: string;
};

export type InAppNotificationPageWire = InAppNotificationWire & {
    dismissed_at: string | null;
    resolved_at: string | null;
    updated_at: string;
};

type InAppNotificationListResponse = {
    notifications: InAppNotificationWire[];
    unreadCount: number;
};

export type InAppNotificationPageResponse = {
    notifications: InAppNotificationPageWire[];
    unreadCount: number;
    nextCursor: string | null;
};

type InAppNotificationCursor = {
    v: typeof IN_APP_NOTIFICATION_CURSOR_VERSION;
    view: InAppNotificationView;
    createdAt: string;
    id: number;
};

export type InAppNotificationPageQuery = {
    view: InAppNotificationView;
    limit: number;
    cursor: InAppNotificationCursor | null;
};

export type InAppNotificationPageQueryParseResult =
    | { ok: true; query: InAppNotificationPageQuery }
    | { ok: false };

type ReminderMissingStatus = {
    missingWeight: boolean;
    missingFood: boolean;
};

type ReminderMissingStatusArgs = {
    userId: number;
    localDate: Date;
    reminderLogWeightEnabled: boolean;
    reminderLogFoodEnabled: boolean;
    db?: InAppNotificationClient;
};

type ResolveInactiveReminderNotificationsArgs = {
    userId: number;
    timeZone: string;
    now?: Date;
    db?: InAppNotificationClient;
};

type ListActiveInAppNotificationsArgs = {
    userId: number;
    db?: InAppNotificationClient;
};

type ListInAppNotificationPageArgs = InAppNotificationPageQuery & {
    userId: number;
    db?: InAppNotificationPageClient;
};

type MarkAllInAppNotificationsReadArgs = {
    userId: number;
    now?: Date;
    db?: InAppNotificationClient;
};

type MarkInAppNotificationArgs = {
    userId: number;
    notificationId: number;
    now?: Date;
    db?: InAppNotificationClient;
};

type NotificationRow = Prisma.InAppNotificationGetPayload<{
    select: {
        id: true;
        type: true;
        local_date: true;
        created_at: true;
        read_at: true;
        title: true;
        body: true;
        action_url: true;
    };
}>;

type NotificationPageRow = Prisma.InAppNotificationGetPayload<{
    select: {
        id: true;
        type: true;
        local_date: true;
        created_at: true;
        updated_at: true;
        read_at: true;
        dismissed_at: true;
        resolved_at: true;
        title: true;
        body: true;
        action_url: true;
    };
}>;

const isSameUtcDate = (left: Date, right: Date): boolean => left.getTime() === right.getTime();

const formatUtcDateOnly = (value: Date): string => value.toISOString().slice(0, 10);

/**
 * Build a stable dedupe key for scheduler-driven reminder notifications.
 */
export const buildReminderInAppDedupeKey = (type: InAppNotificationType, localDate: Date): string => {
    return `reminder:${type}:${formatUtcDateOnly(localDate)}`;
};

/**
 * Build a dev-only reminder dedupe key so dashboard-triggered sends can be tested independently
 * from scheduler-generated reminder rows.
 */
export const buildDevReminderInAppDedupeKey = (type: InAppNotificationType, localDate: Date): string => {
    return `dev:${buildReminderInAppDedupeKey(type, localDate)}`;
};

const isDevReminderDedupeKey = (dedupeKey: string | null | undefined): boolean => {
    return typeof dedupeKey === 'string' && dedupeKey.startsWith(DEV_REMINDER_DEDUPE_KEY_PREFIX);
};

const resolveSerializedActionUrl = (row: NotificationRow): string => {
    const explicitActionUrl = row.action_url?.trim();
    if (explicitActionUrl) {
        return explicitActionUrl;
    }

    return ACTION_URL_BY_TYPE[row.type];
};

const serializeNotification = (row: NotificationRow): InAppNotificationWire => {
    return {
        id: row.id,
        type: row.type,
        local_date: formatUtcDateOnly(row.local_date),
        created_at: row.created_at.toISOString(),
        read_at: row.read_at ? row.read_at.toISOString() : null,
        title: row.title?.trim() || null,
        body: row.body?.trim() || null,
        action_url: resolveSerializedActionUrl(row)
    };
};

const serializeNotificationPageItem = (row: NotificationPageRow): InAppNotificationPageWire => ({
    ...serializeNotification(row),
    dismissed_at: row.dismissed_at ? row.dismissed_at.toISOString() : null,
    resolved_at: row.resolved_at ? row.resolved_at.toISOString() : null,
    updated_at: row.updated_at.toISOString()
});

const isInAppNotificationView = (value: string): value is InAppNotificationView =>
    Object.values(IN_APP_NOTIFICATION_VIEWS).includes(value as InAppNotificationView);

const encodeInAppNotificationCursor = (cursor: InAppNotificationCursor): string =>
    Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');

const decodeInAppNotificationCursor = (
    value: string,
    view: InAppNotificationView
): InAppNotificationCursor | null => {
    try {
        const bytes = Buffer.from(value, 'base64url');
        if (bytes.length === 0 || bytes.toString('base64url') !== value) return null;

        const json = bytes.toString('utf8');
        if (!Buffer.from(json, 'utf8').equals(bytes)) return null;

        const decoded = JSON.parse(json) as Partial<InAppNotificationCursor> | null;
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null;

        const createdAt = typeof decoded.createdAt === 'string' ? new Date(decoded.createdAt) : null;
        if (
            decoded.v !== IN_APP_NOTIFICATION_CURSOR_VERSION ||
            decoded.view !== view ||
            !createdAt ||
            Number.isNaN(createdAt.getTime()) ||
            createdAt.toISOString() !== decoded.createdAt ||
            typeof decoded.id !== 'number' ||
            !Number.isInteger(decoded.id) ||
            decoded.id <= 0
        ) {
            return null;
        }

        return decoded as InAppNotificationCursor;
    } catch {
        return null;
    }
};

/** Parse the additive notification-center paging contract without changing legacy no-query reads. */
export const parseInAppNotificationPageQuery = (
    raw: Record<string, unknown>
): InAppNotificationPageQueryParseResult => {
    if (Object.keys(raw).some((key) => !['view', 'limit', 'cursor'].includes(key))) return { ok: false };

    const rawView = raw.view === undefined ? IN_APP_NOTIFICATION_VIEWS.ACTIVE : raw.view;
    if (typeof rawView !== 'string' || !isInAppNotificationView(rawView)) return { ok: false };

    let limit = DEFAULT_IN_APP_NOTIFICATION_PAGE_LIMIT;
    if (raw.limit !== undefined) {
        if (typeof raw.limit !== 'string' || !/^\d+$/.test(raw.limit)) return { ok: false };
        limit = Number(raw.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_IN_APP_NOTIFICATION_PAGE_LIMIT) {
            return { ok: false };
        }
    }

    let cursor: InAppNotificationCursor | null = null;
    if (raw.cursor !== undefined) {
        if (typeof raw.cursor !== 'string' || raw.cursor.length === 0) return { ok: false };
        cursor = decodeInAppNotificationCursor(raw.cursor, rawView);
        if (!cursor) return { ok: false };
    }

    return { ok: true, query: { view: rawView, limit, cursor } };
};

/**
 * Count today's user logs and derive reminder gaps for each reminder type.
 */
export const getReminderMissingStatusForDate = async ({
    userId,
    localDate,
    reminderLogWeightEnabled,
    reminderLogFoodEnabled,
    db = prisma
}: ReminderMissingStatusArgs): Promise<ReminderMissingStatus> => {
    const activePause = db.foodTrackingPause
        ? await db.foodTrackingPause.findFirst({
              where: {
                  user_id: userId,
                  resumed_on: null,
                  starts_on: { lte: localDate }
              },
              select: { id: true }
          })
        : null;
    if (activePause) {
        return { missingWeight: false, missingFood: false };
    }

    const [foodCount, weightCount, foodDay] = await Promise.all([
        reminderLogFoodEnabled
            ? db.foodLog.count({
                  where: {
                      user_id: userId,
                      local_date: localDate
                  }
              })
            : Promise.resolve(1),
        reminderLogWeightEnabled
            ? db.bodyMetric.count({
                  where: {
                      user_id: userId,
                      date: localDate
                  }
              })
            : Promise.resolve(1),
        reminderLogFoodEnabled && db.foodLogDay
            ? db.foodLogDay.findUnique({
                  where: { user_id_local_date: { user_id: userId, local_date: localDate } },
                  select: { status: true }
              })
            : Promise.resolve(null)
    ]);

    return {
        missingWeight: reminderLogWeightEnabled && weightCount === 0,
        missingFood:
            reminderLogFoodEnabled &&
            foodCount === 0 &&
            (foodDay === null || foodDay.status === 'OPEN')
    };
};

/**
 * Resolve active reminders when the user completes a log or when the local day has passed.
 */
export const resolveInactiveReminderNotificationsForUser = async ({
    userId,
    timeZone,
    now = new Date(),
    db = prisma
}: ResolveInactiveReminderNotificationsArgs): Promise<number> => {
    const [activeNotifications, activePause] = await Promise.all([
        db.inAppNotification.findMany({
        where: {
            user_id: userId,
            type: { in: [...REMINDER_TYPES] },
            dismissed_at: null,
            resolved_at: null
        },
        select: {
            id: true,
            type: true,
            local_date: true,
            dedupe_key: true
        }
        }),
        db.foodTrackingPause
            ? db.foodTrackingPause.findFirst({
                  where: { user_id: userId, resumed_on: null },
                  select: { id: true }
              })
            : Promise.resolve(null)
    ]);

    if (activeNotifications.length === 0) {
        return 0;
    }

    const todayLocalDate = getSafeUtcTodayDateOnlyInTimeZone(timeZone, now);

    const hasTodayFoodReminder = activeNotifications.some(
        (notification) =>
            notification.type === InAppNotificationType.LOG_FOOD_REMINDER &&
            isSameUtcDate(notification.local_date, todayLocalDate)
    );
    const hasTodayWeightReminder = activeNotifications.some(
        (notification) =>
            notification.type === InAppNotificationType.LOG_WEIGHT_REMINDER &&
            isSameUtcDate(notification.local_date, todayLocalDate)
    );

    const [foodCountToday, weightCountToday] = await Promise.all([
        hasTodayFoodReminder
            ? db.foodLog.count({
                  where: {
                      user_id: userId,
                      local_date: todayLocalDate
                  }
              })
            : Promise.resolve(0),
        hasTodayWeightReminder
            ? db.bodyMetric.count({
                  where: {
                      user_id: userId,
                      date: todayLocalDate
                  }
              })
            : Promise.resolve(0)
    ]);

    const idsToResolve = activeNotifications
        .filter((notification) => {
            if (activePause) {
                return true;
            }

            if (notification.local_date.getTime() < todayLocalDate.getTime()) {
                return true;
            }

            if (isDevReminderDedupeKey(notification.dedupe_key)) {
                return false;
            }

            if (
                notification.type === InAppNotificationType.LOG_WEIGHT_REMINDER &&
                isSameUtcDate(notification.local_date, todayLocalDate) &&
                weightCountToday > 0
            ) {
                return true;
            }

            if (
                notification.type === InAppNotificationType.LOG_FOOD_REMINDER &&
                isSameUtcDate(notification.local_date, todayLocalDate) &&
                foodCountToday > 0
            ) {
                return true;
            }

            return false;
        })
        .map((notification) => notification.id);

    if (idsToResolve.length === 0) {
        return 0;
    }

    const result = await db.inAppNotification.updateMany({
        where: {
            user_id: userId,
            id: { in: idsToResolve },
            dismissed_at: null,
            resolved_at: null
        },
        data: {
            resolved_at: now
        }
    });

    if (result.count > 0) {
        publishNotificationRealtimeUpdate({
            userId,
            reason: NOTIFICATION_REALTIME_REASONS.RESOLVED,
            now
        });
    }

    return result.count;
};

/**
 * Fetch active in-app notifications ordered newest-first with an unread count.
 */
export const listActiveInAppNotificationsForUser = async ({
    userId,
    db = prisma
}: ListActiveInAppNotificationsArgs): Promise<InAppNotificationListResponse> => {
    const rows = await db.inAppNotification.findMany({
        where: {
            user_id: userId,
            read_at: null,
            dismissed_at: null,
            resolved_at: null
        },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        select: {
            id: true,
            type: true,
            local_date: true,
            created_at: true,
            read_at: true,
            title: true,
            body: true,
            action_url: true
        }
    });

    return {
        notifications: rows.map(serializeNotification),
        unreadCount: rows.length
    };
};

/**
 * Fetch one owner-scoped notification-center page. The tuple cursor keeps subsequent
 * pages stable when newer notifications arrive ahead of the current snapshot.
 */
export const listInAppNotificationPageForUser = async ({
    userId,
    view,
    limit,
    cursor,
    db = prisma
}: ListInAppNotificationPageArgs): Promise<InAppNotificationPageResponse> => {
    const activeWhere: Prisma.InAppNotificationWhereInput = {
        read_at: null,
        dismissed_at: null,
        resolved_at: null
    };
    const cursorWhere: Prisma.InAppNotificationWhereInput | undefined = cursor
        ? {
              OR: [
                  { created_at: { lt: new Date(cursor.createdAt) } },
                  {
                      created_at: new Date(cursor.createdAt),
                      id: { lt: cursor.id }
                  }
              ]
          }
        : undefined;
    const where: Prisma.InAppNotificationWhereInput = {
        user_id: userId,
        ...(view === IN_APP_NOTIFICATION_VIEWS.ACTIVE ? activeWhere : {}),
        ...(cursorWhere ?? {})
    };

    const [rows, unreadCount] = await Promise.all([
        db.inAppNotification.findMany({
            where,
            orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
            take: limit + 1,
            select: {
                id: true,
                type: true,
                local_date: true,
                created_at: true,
                updated_at: true,
                read_at: true,
                dismissed_at: true,
                resolved_at: true,
                title: true,
                body: true,
                action_url: true
            }
        }),
        db.inAppNotification.count({
            where: {
                user_id: userId,
                ...activeWhere
            }
        })
    ]);

    const hasNextPage = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
        hasNextPage && lastRow
            ? encodeInAppNotificationCursor({
                  v: IN_APP_NOTIFICATION_CURSOR_VERSION,
                  view,
                  createdAt: lastRow.created_at.toISOString(),
                  id: lastRow.id
              })
            : null;

    return {
        notifications: pageRows.map(serializeNotificationPageItem),
        unreadCount,
        nextCursor
    };
};

/**
 * Mark every unread notification owned by a user as read, including resolved history.
 */
export const markAllInAppNotificationsRead = async ({
    userId,
    now = new Date(),
    db = prisma
}: MarkAllInAppNotificationsReadArgs): Promise<number> => {
    const result = await db.inAppNotification.updateMany({
        where: {
            user_id: userId,
            read_at: null
        },
        data: {
            read_at: now
        }
    });

    if (result.count > 0) {
        publishNotificationRealtimeUpdate({
            userId,
            reason: NOTIFICATION_REALTIME_REASONS.READ,
            now
        });
    }

    return result.count;
};
/**
 * Mark a reminder as read (idempotent).
 */
export const markInAppNotificationRead = async ({
    userId,
    notificationId,
    now = new Date(),
    db = prisma
}: MarkInAppNotificationArgs): Promise<number> => {
    const result = await db.inAppNotification.updateMany({
        where: {
            id: notificationId,
            user_id: userId,
            dismissed_at: null,
            resolved_at: null,
            read_at: null
        },
        data: {
            read_at: now
        }
    });

    if (result.count > 0) {
        publishNotificationRealtimeUpdate({
            userId,
            reason: NOTIFICATION_REALTIME_REASONS.READ,
            now
        });
    }

    return result.count;
};

/**
 * Dismiss a reminder from the in-app feed (idempotent).
 */
export const markInAppNotificationDismissed = async ({
    userId,
    notificationId,
    now = new Date(),
    db = prisma
}: MarkInAppNotificationArgs): Promise<number> => {
    let result = await db.inAppNotification.updateMany({
        where: {
            id: notificationId,
            user_id: userId,
            dismissed_at: null,
            resolved_at: null,
            read_at: null
        },
        data: {
            dismissed_at: now,
            read_at: now
        }
    });

    if (result.count === 0) {
        result = await db.inAppNotification.updateMany({
            where: {
                id: notificationId,
                user_id: userId,
                dismissed_at: null,
                resolved_at: null
            },
            data: {
                dismissed_at: now
            }
        });
    }

    if (result.count > 0) {
        publishNotificationRealtimeUpdate({
            userId,
            reason: NOTIFICATION_REALTIME_REASONS.DISMISSED,
            now
        });
    }

    return result.count;
};
