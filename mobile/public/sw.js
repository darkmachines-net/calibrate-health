/** @file Browser service-worker cache lifecycle, offline navigation, update activation, and push delivery. */

const SHELL_CACHE_PREFIX = 'calibrate-expo-web-shell-';
const USER_CACHE_PREFIX = 'calibrate-expo-web-user-';
const CACHE_NAME = `${SHELL_CACHE_PREFIX}v2`;
const APP_SHELL = [
  '/index.html',
  '/manifest.webmanifest',
  '/calibrate-icon.svg',
  '/calibrate-icon-192.png',
  '/calibrate-icon-512.png',
  '/calibrate-icon-maskable-512.png'
];
const DEFAULT_NOTIFICATION_TITLE = 'calibrate';
const DEFAULT_NOTIFICATION_BODY = 'You have a new reminder.';
const DEFAULT_NOTIFICATION_PATH = '/';
const PUSH_SUBSCRIPTION_CHANGED_MESSAGE = 'CALIBRATE_PUSH_SUBSCRIPTION_CHANGED';
const CLEAR_USER_CACHES_MESSAGE = 'CALIBRATE_CLEAR_USER_SCOPED_CACHES';
const USER_CACHES_CLEARED_MESSAGE = 'CALIBRATE_USER_SCOPED_CACHES_CLEARED';

function isBackendPath(pathname) {
  return /^\/(?:api|auth)(?:\/|$)/.test(pathname);
}

function isVersionedStaticAsset(pathname) {
  return /^\/_expo\/static\/(?:js|css)\/.+-[0-9a-f]{8,}\.(?:js|css)$/.test(pathname)
    || /^\/assets\/.+[.-][0-9a-f]{8,}\.[a-z0-9]+$/i.test(pathname);
}

function isExplicitShellAsset(pathname) {
  return pathname !== '/index.html' && APP_SHELL.includes(pathname);
}

function isCacheableStaticAsset(url) {
  return url.origin === self.location.origin
    && (isVersionedStaticAsset(url.pathname) || isExplicitShellAsset(url.pathname));
}

function isCacheableResponse(response) {
  return response.ok && (response.type === 'basic' || response.type === 'default');
}

async function clearUserScopedCaches() {
  const keys = await caches.keys();
  await Promise.all(keys
    .filter((key) => key.startsWith(USER_CACHE_PREFIX))
    .map((key) => caches.delete(key)));
}

function resolveSafeNotificationUrl(value) {
  if (typeof value !== 'string' || value.includes('\\') || value.startsWith('//')) {
    return new URL(DEFAULT_NOTIFICATION_PATH, self.location.origin).href;
  }
  try {
    const url = new URL(value, self.location.origin);
    return url.origin === self.location.origin
      ? url.href
      : new URL(DEFAULT_NOTIFICATION_PATH, self.location.origin).href;
  } catch {
    return new URL(DEFAULT_NOTIFICATION_PATH, self.location.origin).href;
  }
}

function parsePushPayload(event) {
  if (!event.data) return {};
  try {
    const payload = event.data.json();
    return payload && typeof payload === 'object' ? payload : {};
  } catch {
    try {
      return { body: event.data.text() };
    } catch {
      return {};
    }
  }
}

async function notifyWindowClients(message) {
  const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  windowClients.forEach((client) => client.postMessage(message));
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith(SHELL_CACHE_PREFIX) && key !== CACHE_NAME)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
    return;
  }
  if (event.data?.type === CLEAR_USER_CACHES_MESSAGE) {
    event.waitUntil(clearUserScopedCaches().then(() => {
      event.source?.postMessage?.({ type: USER_CACHES_CLEARED_MESSAGE });
    }));
  }
});

self.addEventListener('push', (event) => {
  const payload = parsePushPayload(event);
  const title = typeof payload.title === 'string' && payload.title.trim()
    ? payload.title.trim()
    : DEFAULT_NOTIFICATION_TITLE;
  const body = typeof payload.body === 'string' && payload.body.trim()
    ? payload.body.trim()
    : DEFAULT_NOTIFICATION_BODY;
  const options = {
    body,
    icon: '/calibrate-icon.svg',
    badge: '/calibrate-icon.svg',
    data: {
      ...(payload.data && typeof payload.data === 'object' ? payload.data : {}),
      url: typeof payload.url === 'string' ? payload.url : DEFAULT_NOTIFICATION_PATH,
      actionUrls: payload.actionUrls && typeof payload.actionUrls === 'object' ? payload.actionUrls : {}
    }
  };
  if (typeof payload.tag === 'string' && payload.tag.trim()) options.tag = payload.tag.trim();
  if (Array.isArray(payload.actions)) {
    options.actions = payload.actions.filter((action) => (
      action
      && typeof action.action === 'string'
      && typeof action.title === 'string'
      && action.action.trim()
      && action.title.trim()
    ));
  }
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data && typeof event.notification.data === 'object'
    ? event.notification.data
    : {};
  const actionUrl = event.action && data.actionUrls && typeof data.actionUrls === 'object'
    ? data.actionUrls[event.action]
    : undefined;
  const targetUrl = resolveSafeNotificationUrl(actionUrl || data.url);

  event.waitUntil((async () => {
    const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windowClients) {
      if (!('focus' in client)) continue;
      if ('navigate' in client && client.url !== targetUrl) {
        try {
          await client.navigate(targetUrl);
        } catch {
          // Focusing the existing Calibrate window is still a safe recovery path.
        }
      }
      await client.focus();
      return;
    }
    await self.clients.openWindow(targetUrl);
  })());
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    if (!event.newSubscription && event.oldSubscription?.options) {
      try {
        await self.registration.pushManager.subscribe(event.oldSubscription.options);
      } catch {
        // The open app will surface a user-initiated registration recovery action.
      }
    }
    await notifyWindowClients({
      type: PUSH_SUBSCRIPTION_CHANGED_MESSAGE,
      oldEndpoint: event.oldSubscription?.endpoint
    });
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || isBackendPath(url.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => {
      const cache = await caches.open(CACHE_NAME);
      // Only build-time exported HTML is cached; never store authenticated navigation responses.
      const routePath = url.pathname === '/' ? '/index.html'
        : url.pathname.endsWith('.html') ? url.pathname : `${url.pathname.replace(/\/$/, '')}.html`;
      return (await cache.match(routePath)) ?? (await cache.match('/index.html')) ?? Response.error();
    }));
    return;
  }

  if (!isCacheableStaticAsset(url)) return;
  event.respondWith(caches.open(CACHE_NAME).then(async (cache) => {
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (isCacheableResponse(response)) await cache.put(request, response.clone());
    return response;
  }));
});
