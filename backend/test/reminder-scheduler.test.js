/** @file Regression coverage for reminder scheduler: staggered reminder times remain separate so an earlier type can be receipt-deduped. */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { InAppNotificationType } = require('@prisma/client');

function stubModule(resolvedPath, exports) {
  const moduleInstance = new Module(resolvedPath);
  moduleInstance.exports = exports;
  moduleInstance.loaded = true;
  require.cache[resolvedPath] = moduleInstance;
}

function loadReminderScheduler({ users, deliveryCalls }) {
  const dbPath = require.resolve('../src/config/database');
  const inAppPath = require.resolve('../src/services/inAppNotifications');
  const foodTrackingPath = require.resolve('../src/services/foodTracking');
  const deliveryPath = require.resolve('../src/services/notificationDelivery');
  const payloadPath = require.resolve('../src/services/pushNotificationPayloads');
  const schedulerPath = require.resolve('../src/services/reminderScheduler');
  const stubPaths = [dbPath, inAppPath, foodTrackingPath, deliveryPath, payloadPath];
  const previousModules = new Map(stubPaths.map((stubPath) => [stubPath, require.cache[stubPath]]));
  delete require.cache[schedulerPath];

  stubModule(dbPath, {
    user: {
      findMany: async () => users
    }
  });
  stubModule(inAppPath, {
    buildReminderInAppDedupeKey: (type, localDate) => `${type}:${localDate.toISOString()}`,
    getReminderMissingStatusForDate: async () => ({ missingWeight: true, missingFood: true }),
    resolveInactiveReminderNotificationsForUser: async () => {}
  });
  stubModule(foodTrackingPath, {
    materializeActiveFoodTrackingPauses: async () => {}
  });
  stubModule(deliveryPath, {
    deliverUserNotification: async (request) => {
      deliveryCalls.push(request);
      return {
        channels: request.channels,
        inApp: { attempted: true, created: request.inApp.length, skipped: false, deduped: false },
        push: { attempted: true, sent: 1, failed: 0, skipped: false, deduped: false }
      };
    }
  });
  stubModule(payloadPath, {
    buildReminderPayload: (missing) => missing
  });

  const scheduler = require('../src/services/reminderScheduler');
  for (const stubPath of stubPaths) {
    const previousModule = previousModules.get(stubPath);
    if (previousModule) require.cache[stubPath] = previousModule;
    else delete require.cache[stubPath];
  }
  return scheduler;
}

test('staggered reminder times remain separate so an earlier type can be receipt-deduped', async () => {
  const deliveryCalls = [];
  const { createAndSendScheduledReminders } = loadReminderScheduler({
    users: [{
      id: 7,
      timezone: 'UTC',
      reminder_log_weight_enabled: true,
      reminder_log_food_enabled: true,
      reminder_log_weight_minute: 9 * 60,
      reminder_log_food_minute: 12 * 60,
      reminder_quiet_hours_start_minute: null,
      reminder_quiet_hours_end_minute: null
    }],
    deliveryCalls
  });

  await createAndSendScheduledReminders(new Date('2026-08-09T12:00:00.000Z'));

  assert.equal(deliveryCalls.length, 2);
  assert.deepEqual(deliveryCalls[0].push.reminderTypes, [InAppNotificationType.LOG_WEIGHT_REMINDER]);
  assert.deepEqual(deliveryCalls[0].push.payload, { missingFood: false, missingWeight: true });
  assert.deepEqual(deliveryCalls[1].push.reminderTypes, [InAppNotificationType.LOG_FOOD_REMINDER]);
  assert.deepEqual(deliveryCalls[1].push.payload, { missingFood: true, missingWeight: false });
});

test('equal reminder times remain separate so each type keeps an independent receipt', () => {
  const deliveryCalls = [];
  const { groupDueReminderTypes } = loadReminderScheduler({ users: [], deliveryCalls });

  assert.deepEqual(
    groupDueReminderTypes({
      dueWeight: true,
      dueFood: true
    }),
    [
      [InAppNotificationType.LOG_WEIGHT_REMINDER],
      [InAppNotificationType.LOG_FOOD_REMINDER]
    ]
  );
});
