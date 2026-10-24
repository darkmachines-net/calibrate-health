/** @file Regression coverage for food tracking: background pause materialization excludes accounts without current access. */

const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
const {
  getActiveFoodTrackingPause,
  getEffectiveFoodDay,
  materializeActiveFoodTrackingPauses,
  materializePauseThrough,
  resumeFoodTracking,
  startFoodTrackingPause,
  updateFoodTrackingPauseExpectation
} = require('../src/services/foodTracking');
const {
  getReminderMissingStatusForDate,
  resolveInactiveReminderNotificationsForUser
} = require('../src/services/inAppNotifications');

const day = (value) => new Date(`${value}T00:00:00.000Z`);

function createPauseDatabase() {
  const state = { days: [], pauses: [], syncChanges: [] };
  let nextDayId = 1;
  let nextPauseId = 1;
  const findDay = (userId, localDate) =>
    state.days.find((entry) => entry.user_id === userId && entry.local_date.getTime() === localDate.getTime()) ?? null;
  const db = {
    foodLogDay: {
      findUnique: async ({ where }) => findDay(
        where.user_id_local_date.user_id,
        where.user_id_local_date.local_date
      ),
      create: async ({ data }) => {
        const row = {
          id: nextDayId++,
          completed_at: null,
          created_at: new Date('2026-07-11T08:00:00Z'),
          updated_at: new Date('2026-07-11T08:00:00Z'),
          ...data
        };
        state.days.push(row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = state.days.find((entry) => entry.id === where.id);
        Object.assign(row, data, { updated_at: new Date('2026-07-11T09:00:00Z') });
        return row;
      },
      upsert: async ({ where, update, create }) => {
        const existing = findDay(where.user_id_local_date.user_id, where.user_id_local_date.local_date);
        if (existing) {
          Object.assign(existing, update, { updated_at: new Date('2026-07-14T09:00:00Z') });
          return existing;
        }
        return db.foodLogDay.create({ data: create });
      }
    },
    foodTrackingPause: {
      findFirst: async ({ where }) => state.pauses.find((entry) =>
        entry.user_id === where.user_id && (where.resumed_on !== null || entry.resumed_on === null)
      ) ?? null,
      create: async ({ data }) => {
        const row = {
          id: nextPauseId++,
          resumed_on: null,
          resumed_at: null,
          created_at: data.started_at,
          updated_at: data.started_at,
          ...data
        };
        state.pauses.push(row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = state.pauses.find((entry) => entry.id === where.id);
        Object.assign(row, data, { updated_at: new Date('2026-07-14T09:00:00Z') });
        return row;
      }
    },
    syncChange: {
      create: async ({ data }) => {
        state.syncChanges.push(data);
        return { id: BigInt(state.syncChanges.length), ...data };
      }
    }
  };
  return { db, state };
}

test('background pause materialization excludes accounts without current access', async () => {
  let capturedWhere;
  await materializeActiveFoodTrackingPauses(
    new Date('2026-07-11T08:00:00Z'),
    {
      foodTrackingPause: {
        findMany: async ({ where }) => {
          capturedWhere = where;
          return [];
        }
      },
      $transaction: async () => {
        throw new Error('No pause should be materialized in this fixture.');
      }
    }
  );

  assert.deepEqual(capturedWhere, {
    resumed_on: null,
    user: { is: { email_verified_at: { not: null } } }
  });
});

test('pause lifecycle materializes dates, preserves an explicit override, and reopens resume day', async () => {
  const { db, state } = createPauseDatabase();
  const started = await startFoodTrackingPause({
    tx: db,
    userId: 7,
    startsOn: day('2026-07-11'),
    expectedResumeOn: day('2026-07-14'),
    now: new Date('2026-07-11T08:00:00Z'),
    operationId: 'pause-start-0001'
  });
  assert.equal(started.active, true);
  assert.equal(started.expected_resume_on, '2026-07-14');
  assert.equal(state.days[0].status, 'PAUSED');

  await assert.rejects(
    updateFoodTrackingPauseExpectation({
      tx: db,
      userId: 7,
      expectedResumeOn: day('2026-07-11'),
      today: day('2026-07-11'),
      operationId: 'pause-update-invalid'
    }),
    /INVALID_EXPECTED_RESUME_DATE/
  );

  await updateFoodTrackingPauseExpectation({
    tx: db,
    userId: 7,
    expectedResumeOn: null,
    today: day('2026-07-12'),
    operationId: 'pause-update-001'
  });
  assert.equal(state.pauses[0].expected_resume_on, null);

  state.days.push({
    id: 99,
    user_id: 7,
    local_date: day('2026-07-12'),
    status: 'OPEN',
    origin: 'USER',
    completed_at: null,
    created_at: new Date(),
    updated_at: new Date()
  });
  await materializePauseThrough({
    tx: db,
    pause: state.pauses[0],
    through: day('2026-07-13'),
    operationId: 'pause-catchup-01'
  });
  assert.equal(state.days.find((entry) => entry.local_date.getUTCDate() === 12).status, 'OPEN');
  assert.equal(state.days.find((entry) => entry.local_date.getUTCDate() === 13).status, 'PAUSED');

  const resumed = await resumeFoodTracking({
    tx: db,
    userId: 7,
    resumedOn: day('2026-07-14'),
    now: new Date('2026-07-14T08:00:00Z'),
    operationId: 'pause-resume-001'
  });
  assert.equal(resumed.pause.active, false);
  assert.equal(resumed.pause.resumed_on, '2026-07-14');
  assert.equal(resumed.day.status, 'OPEN');
  assert.equal(state.pauses[0].resumed_on.toISOString().slice(0, 10), '2026-07-14');
  assert.ok(state.syncChanges.some((change) => change.entity_type === 'food_tracking_pause'));
});

test('effective resolution infers only a past blank day inside tracking history', async () => {
  const baseDb = {
    foodLogDay: {
      findUnique: async () => null,
      findFirst: async () => null
    },
    user: {
      findUnique: async () => ({
        created_at: new Date('2026-07-10T12:00:00Z'),
        timezone: 'UTC'
      })
    },
    foodLog: {
      findFirst: async () => null,
      count: async () => 0
    },
    bodyMetric: { findFirst: async () => null },
    foodTrackingPause: { findFirst: async () => null }
  };
  const inferred = await getEffectiveFoodDay(
    7,
    day('2026-07-11'),
    new Date('2026-07-12T12:00:00Z'),
    baseDb
  );
  assert.equal(inferred.status, 'INCOMPLETE');
  assert.equal(inferred.source, 'INFERRED_EMPTY');

  const beforeAccount = await getEffectiveFoodDay(
    7,
    day('2026-07-09'),
    new Date('2026-07-12T12:00:00Z'),
    baseDb
  );
  assert.equal(beforeAccount.status, 'OPEN');
  assert.equal(beforeAccount.source, 'BEFORE_TRACKING_START');

  const blankBetweenImportedHistoryAndAccount = await getEffectiveFoodDay(
    7,
    day('2026-07-07'),
    new Date('2026-07-12T12:00:00Z'),
    {
      ...baseDb,
      foodLog: {
        findFirst: async () => ({ local_date: day('2026-07-05') }),
        count: async () => 0
      }
    }
  );
  assert.equal(blankBetweenImportedHistoryAndAccount.status, 'OPEN');
  assert.equal(blankBetweenImportedHistoryAndAccount.source, 'BEFORE_TRACKING_START');

  const partial = await getEffectiveFoodDay(
    7,
    day('2026-07-11'),
    new Date('2026-07-12T12:00:00Z'),
    {
      ...baseDb,
      foodLog: { ...baseDb.foodLog, count: async () => 1 }
    }
  );
  assert.equal(partial.status, 'OPEN');
  assert.equal(partial.source, 'DEFAULT');
});

test('expected resume date becomes confirmation due without automatically closing the pause', async () => {
  const pause = {
    id: 1,
    user_id: 7,
    starts_on: day('2026-07-11'),
    expected_resume_on: day('2026-07-13'),
    resumed_on: null,
    started_at: new Date('2026-07-11T08:00:00Z'),
    resumed_at: null,
    materialized_through: day('2026-07-12'),
    created_at: new Date('2026-07-11T08:00:00Z'),
    updated_at: new Date('2026-07-12T08:00:00Z')
  };
  const result = await getActiveFoodTrackingPause(
    7,
    new Date('2026-07-13T12:00:00Z'),
    {
      user: { findUnique: async () => ({ timezone: 'UTC' }) },
      foodTrackingPause: { findFirst: async () => pause }
    }
  );
  assert.equal(result.active, true);
  assert.equal(result.resume_confirmation_due, true);
  assert.equal(pause.resumed_on, null);
});

test('active pause suppresses both reminder types and resolves existing reminders', async () => {
  let countReads = 0;
  const missing = await getReminderMissingStatusForDate({
    userId: 7,
    localDate: day('2026-07-11'),
    reminderLogFoodEnabled: true,
    reminderLogWeightEnabled: true,
    db: {
      foodTrackingPause: { findFirst: async () => ({ id: 1 }) },
      foodLog: { count: async () => { countReads += 1; return 0; } },
      bodyMetric: { count: async () => { countReads += 1; return 0; } },
      inAppNotification: {}
    }
  });
  assert.deepEqual(missing, { missingWeight: false, missingFood: false });
  assert.equal(countReads, 0);

  let resolvedIds = [];
  const resolved = await resolveInactiveReminderNotificationsForUser({
    userId: 7,
    timeZone: 'UTC',
    now: new Date('2026-07-11T12:00:00Z'),
    db: {
      foodTrackingPause: { findFirst: async () => ({ id: 1 }) },
      inAppNotification: {
        findMany: async () => [
          { id: 1, type: 'LOG_FOOD_REMINDER', local_date: day('2026-07-11'), dedupe_key: null },
          { id: 2, type: 'LOG_WEIGHT_REMINDER', local_date: day('2026-07-11'), dedupe_key: null }
        ],
        updateMany: async ({ where }) => {
          resolvedIds = where.id.in;
          return { count: where.id.in.length };
        }
      },
      foodLog: { count: async () => 0 },
      bodyMetric: { count: async () => 0 }
    }
  });
  assert.equal(resolved, 2);
  assert.deepEqual(resolvedIds, [1, 2]);
});
