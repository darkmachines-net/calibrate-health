/** @file Regression coverage for notification delivery: native push delivery does not read or send stored tokens while operator mode is disabled. */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const {
  NOTIFICATION_DELIVERY_CHANNELS,
} = require('../../shared/notificationDelivery');
const { diagnosticsRegistry } = require('../src/observability');

const latencyBucketTotal = (counters) => Object.values(counters.latencyBuckets ?? {})
  .reduce((total, count) => total + count, 0);

function stubModule(resolvedPath, exports) {
  const moduleInstance = new Module(resolvedPath);
  moduleInstance.exports = exports;
  moduleInstance.loaded = true;
  require.cache[resolvedPath] = moduleInstance;
}

function loadNotificationDeliveryService({ prismaStub, webPushStub, notificationRealtimeStub, nativePushStub }) {
  const dbPath = require.resolve('../src/config/database');
  const webPushPath = require.resolve('../src/services/webPush');
  const nativePushPath = require.resolve('../src/services/nativePush');
  const notificationRealtimePath = require.resolve('../src/services/notificationRealtime');
  const servicePath = require.resolve('../src/services/notificationDelivery');

  const previousDbModule = require.cache[dbPath];
  const previousWebPushModule = require.cache[webPushPath];
  const previousNativePushModule = require.cache[nativePushPath];
  const previousNotificationRealtimeModule = require.cache[notificationRealtimePath];
  delete require.cache[servicePath];

  stubModule(dbPath, prismaStub);
  stubModule(webPushPath, webPushStub);
  if (nativePushStub) {
    stubModule(nativePushPath, nativePushStub);
  }
  if (notificationRealtimeStub) {
    stubModule(notificationRealtimePath, notificationRealtimeStub);
  }

  const loaded = require('../src/services/notificationDelivery');

  if (previousDbModule) require.cache[dbPath] = previousDbModule;
  else delete require.cache[dbPath];

  if (previousWebPushModule) require.cache[webPushPath] = previousWebPushModule;
  else delete require.cache[webPushPath];

  if (previousNativePushModule) require.cache[nativePushPath] = previousNativePushModule;
  else delete require.cache[nativePushPath];

  if (previousNotificationRealtimeModule) require.cache[notificationRealtimePath] = previousNotificationRealtimeModule;
  else delete require.cache[notificationRealtimePath];

  return loaded;
}

test('native push delivery does not read or send stored tokens while operator mode is disabled', async () => {
  const previousMode = process.env.NATIVE_PUSH_MODE;
  delete process.env.NATIVE_PUSH_MODE;
  let nativeLookupCount = 0;
  try {
    const { deliverUserNotification } = loadNotificationDeliveryService({
      prismaStub: {
        pushSubscription: { findMany: async () => [] },
        nativePushSubscription: {
          findMany: async () => { nativeLookupCount += 1; return [{ token: 'private' }]; }
        }
      },
      webPushStub: {
        ensureWebPushConfigured: () => ({ ok: false, error: 'not configured' }),
        sendWebPushNotification: async () => { throw new Error('should not be called'); }
      }
    });

    const result = await deliverUserNotification({
      userId: 8,
      channels: [NOTIFICATION_DELIVERY_CHANNELS.PUSH],
      push: { payload: { title: 'calibrate', body: 'Reminder', url: '/' } }
    });
    assert.equal(nativeLookupCount, 0);
    assert.equal(result.push.sent, 0);
    assert.equal(result.push.skipped, true);
  } finally {
    if (previousMode === undefined) delete process.env.NATIVE_PUSH_MODE;
    else process.env.NATIVE_PUSH_MODE = previousMode;
  }
});

test('deliverUserNotification creates one in-app notification and dedupes repeated keys', async () => {
  const existingByKey = new Set();
  const createdRows = [];

  const prismaStub = {
    inAppNotification: {
      findUnique: async ({ where }) => {
        const dedupeKey = where.user_id_dedupe_key.dedupe_key;
        return existingByKey.has(dedupeKey) ? { id: 99 } : null;
      },
      create: async ({ data }) => {
        if (data.dedupe_key) {
          existingByKey.add(data.dedupe_key);
        }
        createdRows.push(data);
        return { id: createdRows.length };
      }
    },
    pushSubscription: {
      findUnique: async () => null,
      findMany: async () => [],
      update: async () => {
        throw new Error('should not be called');
      },
      delete: async () => {
        throw new Error('should not be called');
      }
    }
  };

  const webPushStub = {
    ensureWebPushConfigured: () => ({ ok: true }),
    sendWebPushNotification: async () => {
      throw new Error('should not be called');
    }
  };

  const { deliverUserNotification } = loadNotificationDeliveryService({
    prismaStub,
    webPushStub
  });

  const localDate = new Date('2026-02-08T00:00:00.000Z');

  const first = await deliverUserNotification({
    userId: 1,
    channels: [NOTIFICATION_DELIVERY_CHANNELS.IN_APP],
    inApp: {
      type: 'GENERIC',
      localDate,
      title: 'Test title',
      body: 'Test body',
      actionUrl: '/dashboard',
      dedupeKey: 'dev:test:1'
    }
  });

  const second = await deliverUserNotification({
    userId: 1,
    channels: [NOTIFICATION_DELIVERY_CHANNELS.IN_APP],
    inApp: {
      type: 'GENERIC',
      localDate,
      title: 'Test title',
      body: 'Test body',
      actionUrl: '/dashboard',
      dedupeKey: 'dev:test:1'
    }
  });

  assert.equal(first.inApp.created, 1);
  assert.equal(first.inApp.skipped, false);
  assert.equal(first.inApp.deduped, false);
  assert.equal(second.inApp.created, 0);
  assert.equal(second.inApp.skipped, true);
  assert.equal(second.inApp.deduped, true);
  assert.equal(createdRows.length, 1);
  assert.equal(createdRows[0].title, 'Test title');
  assert.equal(createdRows[0].body, 'Test body');
  assert.equal(createdRows[0].action_url, '/dashboard');
});

test('deliverUserNotification publishes realtime update when in-app notification is created', async () => {
  const publishCalls = [];
  const prismaStub = {
    inAppNotification: {
      findUnique: async () => null,
      create: async ({ data }) => ({ id: 1, ...data })
    },
    pushSubscription: {
      findUnique: async () => null,
      findMany: async () => [],
      update: async () => {
        throw new Error('should not be called');
      },
      delete: async () => {
        throw new Error('should not be called');
      }
    }
  };

  const webPushStub = {
    ensureWebPushConfigured: () => ({ ok: true }),
    sendWebPushNotification: async () => {
      throw new Error('should not be called');
    }
  };

  const { deliverUserNotification } = loadNotificationDeliveryService({
    prismaStub,
    webPushStub,
    notificationRealtimeStub: {
      publishNotificationRealtimeUpdate: (args) => {
        publishCalls.push(args);
      }
    }
  });

  const result = await deliverUserNotification({
    userId: 4,
    channels: [NOTIFICATION_DELIVERY_CHANNELS.IN_APP],
    inApp: {
      type: 'GENERIC',
      localDate: new Date('2026-02-08T00:00:00.000Z')
    }
  });

  assert.equal(result.inApp.created, 1);
  assert.equal(publishCalls.length, 1);
  assert.equal(publishCalls[0].userId, 4);
  assert.equal(publishCalls[0].reason, 'created');
});

test('deliverUserNotification skips push when endpoint lookup fails', async () => {
  const prismaStub = {
    inAppNotification: {
      findUnique: async () => null,
      create: async () => {
        throw new Error('should not be called');
      }
    },
    pushSubscription: {
      findUnique: async () => null,
      findMany: async () => {
        throw new Error('should not be called');
      },
      update: async () => {
        throw new Error('should not be called');
      },
      delete: async () => {
        throw new Error('should not be called');
      }
    }
  };

  const webPushStub = {
    ensureWebPushConfigured: () => ({ ok: true }),
    sendWebPushNotification: async () => {
      throw new Error('should not be called');
    }
  };

  const { deliverUserNotification } = loadNotificationDeliveryService({
    prismaStub,
    webPushStub
  });

  const result = await deliverUserNotification({
    userId: 9,
    channels: [NOTIFICATION_DELIVERY_CHANNELS.PUSH],
    push: {
      endpoint: 'https://example.test/push-endpoint',
      payload: {
        title: 'calibrate',
        body: 'hello',
        url: '/'
      }
    }
  });

  assert.equal(result.push.sent, 0);
  assert.equal(result.push.failed, 0);
  assert.equal(result.push.skipped, true);
  assert.equal(result.push.deduped, false);
  assert.match(result.push.message, /No push subscription found/);
});

test('deliverUserNotification sends push and updates last sent date for successful deliveries', async () => {
  const updateCalls = [];
  const sendCalls = [];

  const prismaStub = {
    inAppNotification: {
      findUnique: async () => null,
      create: async () => {
        throw new Error('should not be called');
      }
    },
    pushSubscription: {
      findUnique: async () => ({
        id: 42,
        endpoint: 'https://example.test/push-endpoint',
        p256dh: 'p256dh-key',
        auth: 'auth-key',
        last_sent_local_date: null
      }),
      findMany: async () => [],
      update: async (args) => {
        updateCalls.push(args);
        return { id: args.where.id };
      },
      delete: async () => {
        throw new Error('should not be called');
      }
    }
  };

  const webPushStub = {
    ensureWebPushConfigured: () => ({ ok: true }),
    sendWebPushNotification: async (subscription, payload) => {
      sendCalls.push({ subscription, payload });
      return {};
    }
  };

  const { deliverUserNotification } = loadNotificationDeliveryService({
    prismaStub,
    webPushStub
  });

  const localDate = new Date('2026-02-08T00:00:00.000Z');
  const result = await deliverUserNotification({
    userId: 2,
    channels: [NOTIFICATION_DELIVERY_CHANNELS.PUSH],
    push: {
      endpoint: 'https://example.test/push-endpoint',
      payload: {
        title: 'calibrate',
        body: 'Log your weight for today.',
        url: '/log?quickAdd=weight'
      },
      skipIfLastSentLocalDate: localDate,
      markSentLocalDate: localDate
    }
  });

  assert.equal(result.push.sent, 1);
  assert.equal(result.push.failed, 0);
  assert.equal(result.push.deduped, false);
  assert.equal(sendCalls.length, 1);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].where.id, 42);
  assert.equal(updateCalls[0].data.last_sent_local_date.getTime(), localDate.getTime());
});

test('deliverUserNotification skips push when local-day send already happened', async () => {
  let sendAttempts = 0;

  const localDate = new Date('2026-02-08T00:00:00.000Z');
  const prismaStub = {
    inAppNotification: {
      findUnique: async () => null,
      create: async () => {
        throw new Error('should not be called');
      }
    },
    pushSubscription: {
      findUnique: async () => ({
        id: 11,
        endpoint: 'https://example.test/push-endpoint',
        p256dh: 'p256dh-key',
        auth: 'auth-key',
        last_sent_local_date: localDate
      }),
      findMany: async () => [],
      update: async () => {
        throw new Error('should not be called');
      },
      delete: async () => {
        throw new Error('should not be called');
      }
    }
  };

  const webPushStub = {
    ensureWebPushConfigured: () => ({ ok: true }),
    sendWebPushNotification: async () => {
      sendAttempts += 1;
      return {};
    }
  };

  const { deliverUserNotification } = loadNotificationDeliveryService({
    prismaStub,
    webPushStub
  });

  const result = await deliverUserNotification({
    userId: 2,
    channels: [NOTIFICATION_DELIVERY_CHANNELS.PUSH],
    push: {
      endpoint: 'https://example.test/push-endpoint',
      payload: {
        title: 'calibrate',
        body: 'Log your food for today.',
        url: '/log?quickAdd=food'
      },
      skipIfLastSentLocalDate: localDate,
      markSentLocalDate: localDate
    }
  });

  assert.equal(sendAttempts, 0);
  assert.equal(result.push.sent, 0);
  assert.equal(result.push.failed, 0);
  assert.equal(result.push.skipped, true);
  assert.equal(result.push.deduped, true);
  assert.match(result.push.message, /already received this reminder/);
});
test('records one terminal failure when sent-date persistence fails after web push sends', async () => {
  const before = diagnosticsRegistry.snapshot().operations.notification_delivery ?? {
    attempts: 0,
    successes: 0,
    failures: 0
  };
  const prismaStub = {
    inAppNotification: {
      findUnique: async () => null,
      create: async () => { throw new Error('should not be called'); }
    },
    pushSubscription: {
      findUnique: async () => ({
        id: 77,
        endpoint: 'https://example.test/push-endpoint',
        p256dh: 'p256dh-key',
        auth: 'auth-key',
        last_sent_local_date: null
      }),
      findMany: async () => [],
      update: async () => { throw new Error('sent-date persistence failed'); },
      delete: async () => { throw new Error('should not be called'); }
    }
  };
  const { deliverUserNotification } = loadNotificationDeliveryService({
    prismaStub,
    webPushStub: {
      ensureWebPushConfigured: () => ({ ok: true }),
      sendWebPushNotification: async () => ({})
    }
  });
  const previousWarn = console.warn;
  console.warn = () => undefined;
  let result;
  try {
    result = await deliverUserNotification({
      userId: 2,
      channels: [NOTIFICATION_DELIVERY_CHANNELS.PUSH],
      push: {
        endpoint: 'https://example.test/push-endpoint',
        payload: { title: 'calibrate', body: 'Reminder', url: '/' },
        markSentLocalDate: new Date('2026-02-08T00:00:00.000Z')
      }
    });
  } finally {
    console.warn = previousWarn;
  }

  const after = diagnosticsRegistry.snapshot().operations.notification_delivery;
  assert.equal(result.push.sent, 0);
  assert.equal(result.push.failed, 1);
  assert.equal(after.attempts - before.attempts, 1);
  assert.equal(after.successes - before.successes, 0);
  assert.equal(after.failures - before.failures, 1);
  assert.equal(after.durationSamples - (before.durationSamples ?? 0), 1);
  assert.equal(latencyBucketTotal(after) - latencyBucketTotal(before), 1);
});
test('records one terminal failure when sent-date persistence fails after native push sends', async () => {
  const previousMode = process.env.NATIVE_PUSH_MODE;
  process.env.NATIVE_PUSH_MODE = 'expo';
  const before = diagnosticsRegistry.snapshot().operations.notification_delivery ?? {
    attempts: 0,
    successes: 0,
    failures: 0
  };
  try {
    const { deliverUserNotification } = loadNotificationDeliveryService({
      prismaStub: {
        pushSubscription: { findMany: async () => [] },
        nativePushSubscription: {
          findMany: async () => [{
            id: 88,
            provider: 'EXPO',
            token: 'ExponentPushToken[fixture]',
            last_sent_local_date: null,
            last_sent_weight_local_date: null,
            last_sent_food_local_date: null
          }],
          update: async () => { throw new Error('sent-date persistence failed'); },
          updateMany: async () => { throw new Error('should not be called'); }
        }
      },
      webPushStub: {
        ensureWebPushConfigured: () => ({ ok: false, error: 'not configured' }),
        sendWebPushNotification: async () => { throw new Error('should not be called'); }
      },
      nativePushStub: {
        sendNativePushNotification: async () => ({})
      }
    });
    const previousWarn = console.warn;
    console.warn = () => undefined;
    let result;
    try {
      result = await deliverUserNotification({
        userId: 2,
        channels: [NOTIFICATION_DELIVERY_CHANNELS.PUSH],
        push: {
          payload: { title: 'calibrate', body: 'Reminder', url: '/' },
          markSentLocalDate: new Date('2026-02-08T00:00:00.000Z')
        }
      });
    } finally {
      console.warn = previousWarn;
    }

    const after = diagnosticsRegistry.snapshot().operations.notification_delivery;
    assert.equal(result.push.sent, 0);
    assert.equal(result.push.failed, 1);
    assert.equal(after.attempts - before.attempts, 1);
    assert.equal(after.successes - before.successes, 0);
    assert.equal(after.failures - before.failures, 1);
  assert.equal(after.durationSamples - (before.durationSamples ?? 0), 1);
  assert.equal(latencyBucketTotal(after) - latencyBucketTotal(before), 1);
  } finally {
    if (previousMode === undefined) delete process.env.NATIVE_PUSH_MODE;
    else process.env.NATIVE_PUSH_MODE = previousMode;
  }
});
