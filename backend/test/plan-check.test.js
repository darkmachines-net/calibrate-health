/** @file Boundary and sparse-evidence regressions for descriptive calendar windows, independent of calorie planning. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeTracking } = require('../src/services/planCheckSummary');
const { addUtcDays, getSafeUtcTodayDateOnlyInTimeZone } = require('../src/utils/date');
const today = new Date('2026-11-08T00:00:00Z');

function evidence(days = 28) {
    return { localDate: today, trackingSince: addUtcDays(today, -days), weightUnit: 'KG',
        weights: [28, 14, 7, 1].map(offset => ({ date: addUtcDays(today, -offset), weight_grams: 80000 + offset * 100 })),
        food: [], days: [] };
}

for (const [days, expected] of [[0, []], [6, []], [7, [7]], [13, [7]], [14, [7, 14]], [27, [7, 14]], [28, [7, 14, 28]]]) {
    test(`unlocks only completed tracking durations at ${days} days`, () => {
        assert.deepEqual(summarizeTracking(evidence(days)).windows.map(window => window.days), expected);
    });
}

test('inconsistent food tracking never gates weight summaries or treats missing days as zero', () => {
    const input = evidence();
    input.food = [{ local_date: addUtcDays(today, -1), calories: 800 }, { local_date: addUtcDays(today, -1), calories: 1000 }, { local_date: addUtcDays(today, -3), calories: 2000 }];
    input.days = [{ local_date: addUtcDays(today, -1), status: 'COMPLETE' }, { local_date: addUtcDays(today, -2), status: 'INCOMPLETE' }];
    const window = summarizeTracking(input).windows[0];
    assert.equal(window.averageLoggedCalories, 1900);
    assert.equal(window.loggedFoodDays, 2);
    assert.equal(window.completeFoodDays, 1);
    assert.ok(Math.abs(window.weeklyWeightChangeKg + 0.7) < 0.00001);
});

test('explicit complete empty day is zero while unfinished today and future dates are excluded', () => {
    const input = evidence();
    input.days = [{ local_date: addUtcDays(today, -1), status: 'COMPLETE' }];
    input.food = [{ local_date: today, calories: 500 }, { local_date: addUtcDays(today, 1), calories: 400 }];
    input.weights.push({ date: addUtcDays(today, 1), weight_grams: 100000 });
    const result = summarizeTracking(input);
    assert.equal(result.windows[0].averageLoggedCalories, 0);
    assert.equal(result.windows[0].loggedFoodDays, 1);
    assert.equal(result.latestWeighInDate, '2026-11-07');
});

test('today and yesterday restore trends; older readings hide every weight rate without hiding food coverage', () => {
    for (const [age, fresh] of [[0, true], [1, true], [2, false], [8, false]]) {
        const input = evidence();
        input.weights = [{ date: addUtcDays(today, -28), weight_grams: 83000 }, { date: addUtcDays(today, -age), weight_grams: 80000 }];
        const result = summarizeTracking(input);
        assert.equal(result.needsWeighIn, !fresh);
        assert.equal(result.windows.length, 3);
        assert.equal(result.windows[2].weeklyWeightChangeKg !== null, fresh);
        if (!fresh) assert.ok(result.windows.every(window => window.weightChangeKg === null));
    }
});

test('recent readings clustered together cannot stand in for the whole period', () => {
    const input = evidence();
    input.weights = [{ date: addUtcDays(today, -1), weight_grams: 81000 }, { date: today, weight_grams: 80000 }];
    const result = summarizeTracking(input);
    assert.equal(result.needsWeighIn, false);
    assert.ok(result.windows.every(window => window.weeklyWeightChangeKg === null));
});

test('timezone day boundaries and DST do not change elapsed calendar durations', () => {
    const instant = new Date('2026-11-08T07:30:00Z');
    assert.equal(getSafeUtcTodayDateOnlyInTimeZone('America/Los_Angeles', instant).toISOString().slice(0, 10), '2026-11-07');
    assert.equal(getSafeUtcTodayDateOnlyInTimeZone('Asia/Kathmandu', instant).toISOString().slice(0, 10), '2026-11-08');
    const input = evidence(7);
    input.localDate = getSafeUtcTodayDateOnlyInTimeZone('America/Los_Angeles', new Date('2026-11-08T09:00:00Z'));
    assert.equal(summarizeTracking(input).trackingDays, 7);
});
