/** @file notification reminders: Installs deterministic notification routes with controllable fetch/action failures and synthetic history. */

import type { Page, Route } from '@playwright/test';
import { FROZEN_LOCAL_DATE } from './fixtures';

const REALTIME_EVENT_NAME = 'notification-update';


type NotificationItem = {
  id: number;
  type: 'LOG_WEIGHT_REMINDER' | 'LOG_FOOD_REMINDER' | 'GENERIC';
  local_date: string;
  title: string;
  body: string;
  action_url: string;
  read_at: string | null;
  dismissed_at: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};

type NotificationFixture = {
  failFetchRequests: number;
  failActions: number;
  actionRequests: number;
  holdActions: boolean;
  releaseAction: (() => void) | null;
  listViews: string[];
  readAllRequests: number;
  history: NotificationItem[];
  addIncoming(): NotificationItem;
};

function notification(id: number, overrides: Partial<NotificationItem> = {}): NotificationItem {
  const minute = String(id % 60).padStart(2, '0');
  const isWeight = id % 2 === 1;
  return {
    id,
    type: isWeight ? 'LOG_WEIGHT_REMINDER' : 'LOG_FOOD_REMINDER',
    local_date: FROZEN_LOCAL_DATE,
    title: isWeight ? `Weight reminder ${id}` : `Food reminder ${id}`,
    body: isWeight ? 'Keep your weight trend current.' : 'Finish today\'s food log.',
    action_url: isWeight ? '/log?quickAdd=weight' : '/log?quickAdd=food',
    read_at: null,
    dismissed_at: null,
    resolved_at: null,
    created_at: `2026-07-21T18:${minute}:00.000Z`,
    updated_at: `2026-07-21T18:${minute}:00.000Z`,
    ...overrides,
  };
}

function populatedHistory(): NotificationItem[] {
  const history = Array.from({ length: 23 }, (_, index) => notification(123 - index));
  history[2] = notification(121, { read_at: '2026-07-21T18:45:00.000Z' });
  history[3] = notification(120, {
    read_at: '2026-07-21T18:44:00.000Z',
    dismissed_at: '2026-07-21T18:44:00.000Z',
  });
  history[4] = notification(119, { resolved_at: '2026-07-21T18:43:00.000Z' });
  return history;
}

function fulfillJson(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: status >= 400 ? { 'x-request-id': 'fixture-notification-history' } : undefined,
    body: JSON.stringify(body),
  });
}

function activeNotifications(history: NotificationItem[]) {
  return history.filter((item) => !item.read_at && !item.dismissed_at && !item.resolved_at);
}

/** Installs deterministic notification routes with controllable fetch/action failures and synthetic history. */
export async function installNotificationApi(page: Page, empty = false): Promise<NotificationFixture> {
  const fixture: NotificationFixture = {
    failFetchRequests: 0,
    failActions: 0,
    actionRequests: 0,
    holdActions: false,
    releaseAction: null,
    listViews: [],
    readAllRequests: 0,
    history: empty ? [] : populatedHistory(),
    addIncoming() {
      const incoming = notification(124, {
        title: 'A new reminder arrived',
        body: 'A timely reminder arrived while the panel was open.',
      });
      this.history = [incoming, ...this.history.filter(({ id }) => id !== incoming.id)];
      return incoming;
    },
  };

  await page.route('**/api/v1/notifications/in-app**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const method = request.method();

    if (pathname === '/api/v1/notifications/in-app/read-all' && method === 'PATCH') {
      fixture.readAllRequests += 1;
      return fulfillJson(route, { message: 'The active reminder client must not mark all history read.' }, 400);
    }

    const itemMatch = pathname.match(/^\/api\/v1\/notifications\/in-app\/(\d+)\/(read|dismiss)$/);
    if (itemMatch && method === 'PATCH') {
      fixture.actionRequests += 1;
      if (fixture.holdActions) await new Promise<void>((resolve) => { fixture.releaseAction = resolve; });
      if (fixture.failActions > 0) {
        fixture.failActions -= 1;
        return fulfillJson(route, { message: 'Reminder update unavailable.', code: 'UNAVAILABLE', retryable: true }, 503);
      }
      const id = Number(itemMatch[1]);
      const operation = itemMatch[2];
      fixture.history = fixture.history.map((item) => {
        if (item.id !== id) return item;
        if (operation === 'dismiss' && !item.resolved_at) {
          return {
            ...item,
            read_at: item.read_at ?? '2026-07-21T19:04:00.000Z',
            dismissed_at: item.dismissed_at ?? '2026-07-21T19:04:00.000Z',
          };
        }
        if (operation === 'read' && !item.dismissed_at && !item.resolved_at) {
          return { ...item, read_at: item.read_at ?? '2026-07-21T19:04:00.000Z' };
        }
        return item;
      });
      return fulfillJson(route, { ok: true });
    }

    if (pathname !== '/api/v1/notifications/in-app' || method !== 'GET') return route.fallback();

    const view = url.searchParams.get('view');
    fixture.listViews.push(view ?? 'default');
    if (fixture.failFetchRequests > 0) {
      fixture.failFetchRequests -= 1;
      return fulfillJson(route, { message: 'Reminders unavailable.', code: 'UNAVAILABLE', retryable: true }, 503);
    }
    const active = activeNotifications(fixture.history);
    if (view === 'active') {
      return fulfillJson(route, {
        notifications: active.slice(0, 5),
        unread_count: active.length,
        next_cursor: active.length > 5 ? `after-${active[4].id}` : null,
      });
    }

    if (view === 'history') {
      return fulfillJson(route, { message: 'The active reminder client must not request history.' }, 400);
    }

    return route.fallback();
  });

  return fixture;
}

/** Installs an in-page EventSource substitute so tests can drive notification events without a live server. */
export async function installRealtimeHarness(page: Page) {
  await page.addInitScript((eventName) => {
    type Listener = (event: { data: string }) => void;
    const sources: Array<{ listeners: Map<string, Set<Listener>>; closed: boolean }> = [];

    class FixtureEventSource {
      listeners = new Map<string, Set<Listener>>();
      closed = false;
      onerror: ((event: Event) => unknown) | null = null;

      constructor(_url: string, _options?: EventSourceInit) {
        sources.push(this);
      }

      addEventListener(name: string, listener: Listener) {
        const listeners = this.listeners.get(name) ?? new Set<Listener>();
        listeners.add(listener);
        this.listeners.set(name, listeners);
      }

      close() {
        this.closed = true;
      }
    }

    Object.defineProperty(window, 'EventSource', { configurable: true, value: FixtureEventSource });
    Object.defineProperty(window, '__CALIBRATE_NOTIFICATION_E2E__', {
      configurable: true,
      value: {
        emit(payload: unknown) {
          const event = { data: JSON.stringify(payload) };
          for (const source of sources) {
            if (source.closed) continue;
            for (const listener of source.listeners.get(eventName) ?? []) listener(event);
          }
        },
      },
    });
  }, REALTIME_EVENT_NAME);
}

/** Emits the fixture's notification-created event through the installed realtime harness. */
export async function emitNotificationUpdate(page: Page) {
  await page.evaluate(() => {
    const harness = (window as unknown as {
      __CALIBRATE_NOTIFICATION_E2E__: { emit(payload: unknown): void };
    }).__CALIBRATE_NOTIFICATION_E2E__;
    harness.emit({ reason: 'created', updated_at: '2026-07-21T19:05:00.000Z' });
  });
}

/** Installs a browser permission stub that transitions to denied when the user requests notifications. */
export async function installDeniedBrowserPermission(page: Page) {
  await page.addInitScript(() => {
    let permission: NotificationPermission = 'default';
    const NativeNotification = window.Notification ?? class FixtureNotification {};
    const fixtureNotification = new Proxy(NativeNotification, {
      get(target, property, receiver) {
        if (property === 'permission') return permission;
        if (property === 'requestPermission') {
          return async () => {
            permission = 'denied';
            return permission;
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    Object.defineProperty(window, 'Notification', { configurable: true, value: fixtureNotification });
    Object.defineProperty(window, 'PushManager', {
      configurable: true,
      value: class FixturePushManager {},
    });
    if (!('serviceWorker' in navigator)) {
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: {
          addEventListener() {},
          removeEventListener() {},
          getRegistration: async () => null,
          getRegistrations: async () => [],
        },
      });
    }
  });

  await page.route('**/api/v1/client-config', (route) => fulfillJson(route, {
    api_version: 1,
    server_version: '1.0.0',
    capabilities: {
      self_hosted_server_url: true,
      native_push: false,
      web_push: true,
      health_connect_activity: true,
      wear_os_ready: true,
    },
  }));
}
