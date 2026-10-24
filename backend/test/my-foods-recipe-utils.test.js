/** @file Regression coverage for my foods recipe utils: myFoodsRecipeUtils: parseMyFoodIngredientInput validates ids and quantities. */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildExternalIngredientSnapshotRow,
  buildFoodLogIngredientSnapshotRow,
  parseMyFoodIngredientInput
} = require('../src/routes/myFoodsRecipeUtils');

test('myFoodsRecipeUtils: parseMyFoodIngredientInput validates ids and quantities', () => {
  const ok = parseMyFoodIngredientInput({ my_food_id: '123', quantity_servings: '1.5' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { myFoodId: 123, quantityServings: 1.5 });

  const badId = parseMyFoodIngredientInput({ my_food_id: 0, quantity_servings: 1 });
  assert.equal(badId.ok, false);
  assert.equal(badId.error.statusCode, 400);
  assert.equal(badId.error.message, 'Invalid ingredient my_food_id');

  const badQty = parseMyFoodIngredientInput({ my_food_id: 123, quantity_servings: 0 });
  assert.equal(badQty.ok, false);
  assert.equal(badQty.error.statusCode, 400);
  assert.equal(badQty.error.message, 'Invalid ingredient quantity_servings');
});

test('myFoodsRecipeUtils: buildExternalIngredientSnapshotRow validates required fields and normalizes optionals', () => {
  const ok = buildExternalIngredientSnapshotRow(
    {
      name: '  Tomato   sauce ',
      calories_total: '120',
      external_source: '   OF  ',
      quantity_servings: '1.5',
      serving_size_quantity: '30',
      serving_unit_label: '  fl   oz ',
      calories_per_serving: '80.5',
      grams_total: '250',
      grams_per_measure: 'abc' // invalid optional value -> becomes null
    },
    2
  );

  assert.equal(ok.ok, true);
  assert.equal(ok.value.sort_order, 2);
  assert.equal(ok.value.source, 'EXTERNAL');
  assert.equal(ok.value.name_snapshot, 'Tomato sauce');
  assert.equal(ok.value.calories_total_snapshot, 120);
  assert.equal(ok.value.external_source, 'OF');
  assert.equal(ok.value.quantity_servings, 1.5);
  assert.equal(ok.value.serving_size_quantity_snapshot, 30);
  assert.equal(ok.value.serving_unit_label_snapshot, 'fl oz');
  assert.equal(ok.value.calories_per_serving_snapshot, 80.5);
  assert.equal(ok.value.grams_total_snapshot, 250);
  assert.equal(ok.value.grams_per_measure_snapshot, null);
});

test('myFoodsRecipeUtils: buildExternalIngredientSnapshotRow rejects invalid inputs', () => {
  const badName = buildExternalIngredientSnapshotRow({ name: '', calories_total: 10 }, 1);
  assert.equal(badName.ok, false);
  assert.equal(badName.error.statusCode, 400);
  assert.equal(badName.error.message, 'Invalid external ingredient name');

  const badCalories = buildExternalIngredientSnapshotRow({ name: 'x', calories_total: 'nope' }, 1);
  assert.equal(badCalories.ok, false);
  assert.equal(badCalories.error.statusCode, 400);
  assert.equal(badCalories.error.message, 'Invalid external ingredient calories_total');
});

test('myFoodsRecipeUtils: buildFoodLogIngredientSnapshotRow preserves every historical snapshot', () => {
  const row = buildFoodLogIngredientSnapshotRow({
    name: 'Logged margarita',
    calories: 0,
    servings_consumed: 1.25,
    serving_size_quantity_snapshot: 4,
    serving_unit_label_snapshot: 'fl oz',
    calories_per_serving_snapshot: 0,
    external_source: 'fatsecret',
    external_id: 'drink-42',
    brand_snapshot: 'House brand',
    locale_snapshot: 'en-US',
    barcode_snapshot: '0123456789012',
    measure_label_snapshot: 'glass',
    grams_per_measure_snapshot: 118.25,
    measure_quantity_snapshot: 1.25,
    grams_total_snapshot: 147.8125
  }, 3);

  assert.deepEqual(row, {
    sort_order: 3,
    source: 'EXTERNAL',
    name_snapshot: 'Logged margarita',
    calories_total_snapshot: 0,
    quantity_servings: 1.25,
    serving_size_quantity_snapshot: 4,
    serving_unit_label_snapshot: 'fl oz',
    calories_per_serving_snapshot: 0,
    external_source: 'fatsecret',
    external_id: 'drink-42',
    brand_snapshot: 'House brand',
    locale_snapshot: 'en-US',
    barcode_snapshot: '0123456789012',
    measure_label_snapshot: 'glass',
    grams_per_measure_snapshot: 118.25,
    measure_quantity_snapshot: 1.25,
    grams_total_snapshot: 147.8125
  });
});
