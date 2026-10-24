import express from 'express';
import { NativePushPlatform, NativePushProvider } from '@prisma/client';
import prisma from '../config/database';
import { NATIVE_PUSH_MODES, resolveNativePushMode } from '../config/nativePush';
import {
  listActiveInAppNotificationsForUser,
  listInAppNotificationPageForUser,
  markAllInAppNotificationsRead,
  markInAppNotificationDismissed,
  markInAppNotificationRead,
  parseInAppNotificationPageQuery,
  resolveInactiveReminderNotificationsForUser
} from '../services/inAppNotifications';
import { getWebPushPublicKey } from '../services/webPush';
import {
  NOTIFICATION_REALTIME_EVENT_NAME,
  subscribeToNotificationRealtimeUpdates
} from '../services/notificationRealtime';
import { parsePositiveInteger } from '../utils/requestParsing';
import { MOBILE_DEVICE_PLATFORMS, NATIVE_PUSH_PLATFORMS, NATIVE_PUSH_PROVIDERS } from '../../../shared/domain';
import { getAuthenticatedUser, requireAuthenticatedUser } from '../middleware/authenticatedUser';

/**
 * Push notification subscription endpoints plus in-app reminder feed endpoints.
 */
const router = express.Router();
const SSE_HEARTBEAT_INTERVAL_MS = 25_000; // Keep intermediaries from closing otherwise-idle notification streams.

/** Web Push is owned by a persisted cookie session, never by a native bearer session. */
const isBrowserSession = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (typeof res.locals.mobileAuthSessionId === 'number' || !req.sessionID) {
    return res.status(403).json({ message: 'Browser session required.' });
  }
  return next();
};

router.use(requireAuthenticatedUser);

/**
 * Stream per-user notification state changes to the authenticated browser session.
 */
router.get('/stream', (req, res) => {
  const user = getAuthenticatedUser(req);

  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
  res.write(': connected\n\n');

  const writeEvent = (payload: unknown) => {
    res.write(`event: ${NOTIFICATION_REALTIME_EVENT_NAME}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const unsubscribe = subscribeToNotificationRealtimeUpdates({
    userId: user.id,
    onUpdate: writeEvent
  });

  const heartbeatId = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, SSE_HEARTBEAT_INTERVAL_MS);
  heartbeatId.unref();

  res.once('close', () => {
    clearInterval(heartbeatId);
    unsubscribe();
  });
});

router.get('/public-key', (_req, res) => {
  const { publicKey, error } = getWebPushPublicKey();
  if (!publicKey) {
    return res.status(500).json({ message: error ?? 'Web push is not configured.' });
  }

  res.json({ publicKey });
});

router.post('/subscription', isBrowserSession, async (req, res) => {
  const user = getAuthenticatedUser(req);
  const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint.trim() : '';
  const keys = req.body?.keys as { p256dh?: unknown; auth?: unknown } | undefined;
  const p256dh = typeof keys?.p256dh === 'string' ? keys?.p256dh.trim() : '';
  const auth = typeof keys?.auth === 'string' ? keys?.auth.trim() : '';
  const expirationTimeRaw = req.body?.expirationTime;
  const expirationTime =
    typeof expirationTimeRaw === 'number' && Number.isFinite(expirationTimeRaw)
      ? new Date(expirationTimeRaw)
      : null;

  if (!endpoint || !p256dh || !auth) {
    return res.status(400).json({ message: 'Invalid subscription payload.' });
  }

  await prisma.pushSubscription.upsert({
    where: { endpoint },
    update: {
      // A browser push endpoint belongs to one current account. Re-registering it
      // after an account switch transfers delivery instead of duplicating it.
      user_id: user.id,
      session_sid: req.sessionID,
      p256dh,
      auth,
      expiration_time: expirationTime,
      // Registration is an explicit opt-in. Clear any delivery date inherited
      // from a previous owner of this globally unique browser endpoint.
      last_sent_local_date: null,
      last_sent_weight_local_date: null,
      last_sent_food_local_date: null
    },
    create: {
      user_id: user.id,
      session_sid: req.sessionID,
      endpoint,
      p256dh,
      auth,
      expiration_time: expirationTime
    }
  });

  res.json({ ok: true });
});

router.delete('/subscription', isBrowserSession, async (req, res) => {
  const user = getAuthenticatedUser(req);
  const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint.trim() : '';

  if (!endpoint) {
    return res.status(400).json({ message: 'Endpoint is required.' });
  }

  // Keep unsubscribe idempotent and owner-scoped. A stale account session must
  // not delete an endpoint after another account has claimed it.
  await prisma.pushSubscription.deleteMany({
    where: { user_id: user.id, session_sid: req.sessionID, endpoint }
  });

  res.json({ ok: true });
});

const parseNativePushPlatform = (value: unknown): NativePushPlatform | null => {
  if (value === undefined || value === null || value === NATIVE_PUSH_PLATFORMS.ANDROID) {
    return NativePushPlatform.ANDROID;
  }
  if (value === NATIVE_PUSH_PLATFORMS.IOS) {
    return NativePushPlatform.IOS;
  }
  return null;
};

const parseNativePushProvider = (value: unknown): NativePushProvider | null => {
  if (value === undefined || value === null || value === NATIVE_PUSH_PROVIDERS.EXPO) {
    return NativePushProvider.EXPO;
  }
  return null;
};

const normalizeNativeText = (value: unknown, maxLength: number): string => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
};

const isExpoPushToken = (token: string): boolean =>
  /^(?:Exponent|Expo)PushToken\[[^[\]]+\]$/.test(token);

router.post('/native-subscription', async (req, res) => {
  const user = getAuthenticatedUser(req);
  const token = normalizeNativeText(req.body?.token, 512);
  const mobileAuthSessionId = res.locals.mobileAuthSessionId as number | undefined;
  const deviceId = res.locals.mobileDeviceId as string | undefined;
  const platform = parseNativePushPlatform(req.body?.platform);
  const provider = parseNativePushProvider(req.body?.provider);
  const authenticatedDevicePlatform = res.locals.mobileDevicePlatform as string | undefined;
  const expectedPushPlatform = authenticatedDevicePlatform === MOBILE_DEVICE_PLATFORMS.IOS
    ? NativePushPlatform.IOS
    : authenticatedDevicePlatform === MOBILE_DEVICE_PLATFORMS.ANDROID_PHONE
      ? NativePushPlatform.ANDROID
      : null;

  if (!mobileAuthSessionId || !deviceId) {
    return res.status(401).json({ message: 'Mobile authentication required.' });
  }
  if (!token) {
    return res.status(400).json({ message: 'token is required.' });
  }
  if (!platform) {
    return res.status(400).json({ message: 'Invalid native push platform.' });
  }
  if (!provider) {
    return res.status(400).json({ message: 'Invalid or unsupported native push provider.' });
  }
  if (!expectedPushPlatform || platform !== expectedPushPlatform) {
    return res.status(400).json({ message: 'Native push platform does not match the authenticated device.' });
  }
  if (provider === NativePushProvider.EXPO && !isExpoPushToken(token)) {
    return res.status(400).json({ message: 'Invalid Expo push token.' });
  }
  if (resolveNativePushMode() !== NATIVE_PUSH_MODES.EXPO) {
    return res.status(503).json({
      message: 'Native push is disabled by this server.',
      code: 'NATIVE_PUSH_DISABLED'
    });
  }

  await prisma.nativePushSubscription.upsert({
    where: {
      provider_token: {
        provider,
        token
      }
    },
    update: {
      user_id: user.id,
      mobile_auth_session_id: mobileAuthSessionId,
      device_id: deviceId,
      platform,
      last_sent_local_date: null,
      last_sent_weight_local_date: null,
      last_sent_food_local_date: null,
      revoked_at: null
    },
    create: {
      user_id: user.id,
      mobile_auth_session_id: mobileAuthSessionId,
      device_id: deviceId,
      platform,
      provider,
      token
    }
  });

  // One authenticated install owns one active token per provider. Expo can rotate a token while
  // the app is running; retire the previous value immediately instead of waiting for a failed send.
  await prisma.nativePushSubscription.updateMany({
    where: {
      user_id: user.id,
      mobile_auth_session_id: mobileAuthSessionId,
      provider,
      token: { not: token },
      revoked_at: null
    },
    data: { revoked_at: new Date() }
  });

  res.json({ ok: true });
});

router.delete('/native-subscription', async (req, res) => {
  const user = getAuthenticatedUser(req);
  const token = normalizeNativeText(req.body?.token, 512);
  const mobileAuthSessionId = res.locals.mobileAuthSessionId as number | undefined;
  const provider = parseNativePushProvider(req.body?.provider);

  if (!mobileAuthSessionId) {
    return res.status(401).json({ message: 'Mobile authentication required.' });
  }
  if (!provider) {
    return res.status(400).json({ message: 'Invalid or unsupported native push provider.' });
  }

  await prisma.nativePushSubscription.updateMany({
    where: {
      user_id: user.id,
      mobile_auth_session_id: mobileAuthSessionId,
      provider,
      ...(token ? { token } : {}),
      revoked_at: null
    },
    data: {
      revoked_at: new Date()
    }
  });

  res.json({ ok: true });
});

/**
 * Return active in-app reminders, resolving stale/completed entries first.
 */
router.get('/in-app', async (req, res) => {
  const user = getAuthenticatedUser(req);
  const timeZone = user.timezone || 'UTC';
  const isLegacyRequest = Object.keys(req.query).length === 0;
  const parsedQuery = isLegacyRequest
    ? null
    : parseInAppNotificationPageQuery(req.query as Record<string, unknown>);

  if (parsedQuery && !parsedQuery.ok) {
    return res.status(400).json({ message: 'Invalid notification query.' });
  }

  await resolveInactiveReminderNotificationsForUser({
    userId: user.id,
    timeZone
  });

  if (isLegacyRequest) {
    const { notifications, unreadCount } = await listActiveInAppNotificationsForUser({ userId: user.id });
    return res.json({ notifications, unread_count: unreadCount });
  }

  const { notifications, unreadCount, nextCursor } = await listInAppNotificationPageForUser({
    userId: user.id,
    ...parsedQuery!.query
  });
  return res.json({ notifications, unread_count: unreadCount, next_cursor: nextCursor });
});

router.patch('/in-app/read-all', async (req, res) => {
  const user = getAuthenticatedUser(req);
  const updatedCount = await markAllInAppNotificationsRead({ userId: user.id });
  res.json({ ok: true, updated_count: updatedCount });
});

router.patch('/in-app/:notificationId/read', async (req, res) => {
  const user = getAuthenticatedUser(req);
  const notificationId = parsePositiveInteger(req.params.notificationId);
  if (!notificationId) {
    return res.status(400).json({ message: 'Invalid notification id.' });
  }

  await markInAppNotificationRead({
    userId: user.id,
    notificationId
  });

  res.json({ ok: true });
});

router.patch('/in-app/:notificationId/dismiss', async (req, res) => {
  const user = getAuthenticatedUser(req);
  const notificationId = parsePositiveInteger(req.params.notificationId);
  if (!notificationId) {
    return res.status(400).json({ message: 'Invalid notification id.' });
  }

  await markInAppNotificationDismissed({
    userId: user.id,
    notificationId
  });

  res.json({ ok: true });
});

export default router;
