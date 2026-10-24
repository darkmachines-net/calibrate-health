/** @file Regression coverage for food utils: foodUtils: parseFoodSearchParams requires a query or barcode. */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseFoodLogCreateBody,
  parseFoodLogUpdateBody,
  parseFoodSearchParams
} = require('../src/routes/foodUtils');

test('foodUtils: parseFoodSearchParams requires a query or barcode', () => {
  const missing = parseFoodSearchParams({ query: {}, acceptLanguageHeader: undefined });
  assert.equal(missing.ok, false);
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.message, 'Provide a search query or barcode.');

  const withQuery = parseFoodSearchParams({
    query: { q: 'banana', page: '2', pageSize: '10', grams: '50', lc: 'en' },
    acceptLanguageHeader: 'fr-FR,fr;q=0.9'
  });
  assert.equal(withQuery.ok, true);
  assert.deepEqual(withQuery.params, {
    query: 'banana',
    barcode: undefined,
    page: 2,
    pageSize: 10,
    quantityInGrams: 50,
    languageCode: 'en'
  });
});

test('foodUtils: parseFoodSearchParams trims queries and rejects invalid numeric filters', () => {
  const blank = parseFoodSearchParams({ query: { q: '   ' }, acceptLanguageHeader: undefined });
  assert.equal(blank.ok, false);
  assert.equal(blank.message, 'Provide a search query or barcode.');

  const trimmed = parseFoodSearchParams({
    query: { query: '  apple  ', page: '1', pageSize: '5', grams: '50' },
    acceptLanguageHeader: undefined
  });
  assert.equal(trimmed.ok, true);
  assert.equal(trimmed.params.query, 'apple');
  assert.equal(trimmed.params.page, 1);
  assert.equal(trimmed.params.pageSize, 5);
  assert.equal(trimmed.params.quantityInGrams, 50);

  const invalidPage = parseFoodSearchParams({ query: { q: 'apple', page: '0' }, acceptLanguageHeader: undefined });
  assert.equal(invalidPage.ok, false);
  assert.equal(invalidPage.message, 'Invalid page');

  const invalidPageSize = parseFoodSearchParams({ query: { q: 'apple', pageSize: '-1' }, acceptLanguageHeader: undefined });
  assert.equal(invalidPageSize.ok, false);
  assert.equal(invalidPageSize.message, 'Invalid page size');

  const invalidGrams = parseFoodSearchParams({ query: { q: 'apple', grams: '50g' }, acceptLanguageHeader: undefined });
  assert.equal(invalidGrams.ok, false);
  assert.equal(invalidGrams.message, 'Invalid grams');
});

test('foodUtils: parseFoodLogCreateBody rejects invalid bodies and meal periods', () => {
  assert.equal(parseFoodLogCreateBody({ body: null, userTimeZone: 'UTC' }).ok, false);

  const badPeriod = parseFoodLogCreateBody({
    body: { meal_period: 'INVALID', name: 'Apple', calories: 10 },
    userTimeZone: 'UTC'
  });
  assert.equal(badPeriod.ok, false);
  assert.equal(badPeriod.statusCode, 400);
  assert.equal(badPeriod.message, 'Invalid meal period');
});

test('foodUtils: parseFoodLogCreateBody defaults date fields when date is omitted', () => {
  const now = new Date('2025-01-02T05:00:00Z');
  const result = parseFoodLogCreateBody({
    body: { meal_period: 'BREAKFAST', name: 'Apple', calories: 12.4 },
    userTimeZone: 'America/Los_Angeles',
    now
  });

  assert.equal(result.ok, true);
  assert.equal(result.kind, 'MANUAL');
  assert.equal(result.entryTimestamp.toISOString(), now.toISOString());
  // 05:00Z is still the previous local day in America/Los_Angeles.
  assert.equal(result.localDate.toISOString(), '2025-01-01T00:00:00.000Z');
  assert.equal(result.calories, 12);
});

test('foodUtils: parseFoodLogCreateBody preserves optional external serving snapshots', () => {
  const result = parseFoodLogCreateBody({
    body: {
      meal_period: 'LUNCH',
      name: 'Provider yogurt',
      calories: 180,
      servings_consumed: '1.5',
      serving_size_quantity_snapshot: '1',
      serving_unit_label_snapshot: 'cup',
      external_source: 'openFoodFacts',
      external_id: 'abc123',
      brand: ' Test Brand ',
      measure_label: 'cup',
      grams_per_measure_snapshot: '170',
      measure_quantity_snapshot: '1.5',
      grams_total_snapshot: '255',
      date: '2025-01-01'
    },
    userTimeZone: 'UTC'
  });

  assert.equal(result.ok, true);
  assert.equal(result.kind, 'MANUAL');
  assert.equal(result.servingsConsumed, 1.5);
  assert.equal(result.servingSizeQuantitySnapshot, 1);
  assert.equal(result.servingUnitLabelSnapshot, 'cup');
  assert.equal(result.caloriesPerServingSnapshot, 120);
  assert.equal(result.externalSource, 'openFoodFacts');
  assert.equal(result.externalId, 'abc123');
  assert.equal(result.brandSnapshot, 'Test Brand');
  assert.equal(result.measureLabelSnapshot, 'cup');
  assert.equal(result.gramsPerMeasureSnapshot, 170);
  assert.equal(result.measureQuantitySnapshot, 1.5);
  assert.equal(result.gramsTotalSnapshot, 255);
});

test('foodUtils: parseFoodLogCreateBody rejects invalid dates and mutual exclusivity', () => {
  const badDate = parseFoodLogCreateBody({
    body: { meal_period: 'LUNCH', name: 'Apple', calories: 10, date: 'not-a-date' },
    userTimeZone: 'UTC'
  });
  assert.equal(badDate.ok, false);
  assert.equal(badDate.message, 'Invalid date');

  const both = parseFoodLogCreateBody({
    body: { meal_period: 'LUNCH', name: 'Apple', calories: 10, my_food_id: '1', servings_consumed: 1 },
    userTimeZone: 'UTC'
  });
  assert.equal(both.ok, false);
  assert.equal(both.message, 'Provide either my_food_id+servings_consumed or name+calories, not both.');
});

test('foodUtils: parseFoodLogCreateBody parses my_food_id and servings_consumed inputs', () => {
  const ok = parseFoodLogCreateBody({
    body: { meal_period: 'DINNER', my_food_id: '42', servings_consumed: '1.5', date: '2025-01-01' },
    userTimeZone: 'UTC'
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.kind, 'MY_FOOD');
  assert.equal(ok.myFoodId, 42);
  assert.equal(ok.servingsConsumed, 1.5);
  assert.equal(ok.localDate.toISOString(), '2025-01-01T00:00:00.000Z');
  assert.equal(ok.entryTimestamp.toISOString(), '2025-01-01T00:00:00.000Z');
});

test('foodUtils: parseFoodLogUpdateBody rejects non-object bodies and empty updates', () => {
  const nonObject = parseFoodLogUpdateBody({ body: null, existing: {} });
  assert.equal(nonObject.ok, false);
  assert.equal(nonObject.message, 'Invalid request body');

  const empty = parseFoodLogUpdateBody({ body: {}, existing: {} });
  assert.equal(empty.ok, false);
  assert.equal(empty.message, 'No fields to update');
});

test('foodUtils: parseFoodLogUpdateBody computes calories from servings when snapshot exists', () => {
  const parsed = parseFoodLogUpdateBody({
    body: { servings_consumed: 2 },
    existing: { calories_per_serving_snapshot: 110 }
  });

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.updateData, {
    servings_consumed: 2,
    calories: 220
  });
});

test('foodUtils: parseFoodLogUpdateBody updates measure and gram snapshots without losing a precise calorie basis', () => {
  const parsed = parseFoodLogUpdateBody({
    body: { servings_consumed: 142 },
    existing: {
      calories_per_serving_snapshot: 0.04,
      servings_consumed: 100,
      grams_per_measure_snapshot: 1,
      measure_quantity_snapshot: 100,
      grams_total_snapshot: 100
    }
  });

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.updateData, {
    servings_consumed: 142,
    calories: 6,
    measure_quantity_snapshot: 142,
    grams_total_snapshot: 142
  });
});

test('foodUtils: parseFoodLogUpdateBody derives legacy per-100g totals from the stored measure ratio', () => {
  const parsed = parseFoodLogUpdateBody({
    body: { servings_consumed: 1.42 },
    existing: {
      calories_per_serving_snapshot: 59,
      servings_consumed: 1,
      grams_per_measure_snapshot: 100,
      measure_quantity_snapshot: 1,
      grams_total_snapshot: 100
    }
  });

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.updateData, {
    servings_consumed: 1.42,
    calories: 84,
    measure_quantity_snapshot: 1.42,
    grams_total_snapshot: 142
  });
});

test('foodUtils: parseFoodLogUpdateBody rejects servings updates when the entry has no snapshot', () => {
  const parsed = parseFoodLogUpdateBody({
    body: { servings_consumed: 2 },
    existing: { calories_per_serving_snapshot: null }
  });

  assert.equal(parsed.ok, false);
  assert.equal(parsed.message, 'This entry does not include serving info.');
});

test('foodUtils: parseFoodLogUpdateBody derives calories_per_serving_snapshot from calories and servings', () => {
  const parsed = parseFoodLogUpdateBody({
    body: { calories: 250 },
    existing: { servings_consumed: 2 }
  });

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.updateData, {
    calories: 250,
    calories_per_serving_snapshot: 125
  });
});

test('foodUtils: parseFoodLogUpdateBody treats supplied calories as an explicit per-serving override', () => {
  const parsed = parseFoodLogUpdateBody({
    body: { servings_consumed: 142, calories: 90 },
    existing: {
      calories_per_serving_snapshot: 0.59,
      servings_consumed: 100,
      grams_per_measure_snapshot: 1,
      measure_quantity_snapshot: 100,
      grams_total_snapshot: 100
    }
  });

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.updateData, {
    servings_consumed: 142,
    calories: 90,
    measure_quantity_snapshot: 142,
    grams_total_snapshot: 142,
    calories_per_serving_snapshot: 90 / 142
  });
});

test('foodUtils: parseFoodLogUpdateBody clears a stale gram total when no conversion ratio exists', () => {
  const parsed = parseFoodLogUpdateBody({
    body: { servings_consumed: 2, calories: 200 },
    existing: {
      calories_per_serving_snapshot: null,
      servings_consumed: null,
      grams_per_measure_snapshot: null,
      measure_quantity_snapshot: null,
      grams_total_snapshot: 142
    }
  });

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.updateData, {
    servings_consumed: 2,
    calories: 200,
    measure_quantity_snapshot: 2,
    grams_total_snapshot: null,
    calories_per_serving_snapshot: 100
  });
});
