/** @file Regression coverage for nutrition label parser: extracts calories and preserves the printed household unit and metric equivalent. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseNutritionLabel } = require('../src/services/nutritionLabels/parser');

test('extracts calories and preserves the printed household unit and metric equivalent', () => {
  assert.deepEqual(parseNutritionLabel('Nutrition Facts\n8 servings per container\nServing size 2 tbsp (32 g)\nAmount per serving\nCalories 190\nTotal Fat 16g 21%'), {
    calories_per_serving: 190, serving_size_quantity: 2, serving_unit_label: 'tbsp (32 g)',
    serving_text: '2 tbsp (32 g)', warnings: []
  });
});

for (const [printed, quantity, unit] of [
  ['2/3 cup (55g)', 2 / 3, 'cup (55g)'],
  ['½ cup (125 mL)', 0.5, 'cup (125 mL)'],
  ['1½ cups (240 g)', 1.5, 'cups (240 g)'],
  ['1 1/4 cups', 1.25, 'cups'],
  ['30g', 30, 'g'],
  ['240 mL', 240, 'mL'],
  ['1,5 oz (42 g)', 1.5, 'oz (42 g)'],
  ['3 pieces (28 g)', 3, 'pieces (28 g)']
]) {
  test('parses serving size ' + printed, () => {
    const result = parseNutritionLabel('Serving Size:\n' + printed + '\nCalories\n150');
    assert.equal(result.serving_size_quantity, quantity);
    assert.equal(result.serving_unit_label, unit);
    assert.equal(result.calories_per_serving, 150);
  });
}

test('explicit zero calories are valid while unreadable values remain null', () => {
  assert.equal(parseNutritionLabel('Serving size 1 cup\nCalories 0').calories_per_serving, 0);
  const result = parseNutritionLabel('Nutrition Facts\nTotal Fat 0g\nCalories from fat 0');
  assert.equal(result.calories_per_serving, null);
  assert.equal(result.serving_size_quantity, null);
  assert.equal(result.serving_unit_label, null);
  assert.equal(result.warnings.length, 2);
});

for (const label of [
  'Calories 150 300',
  'Calories\n150\n300',
  'Calories 150\n300',
  'Calories 150\nCalories 300',
  'Per serving Per container\nCalories 150',
  'Per 100 g\nCalories 150',
  'As packaged As prepared\nCalories 150',
  'Calories < 5',
  'Energy 840 kJ / 200 kcal'
]) {
  test('does not guess calories from ambiguous or unsupported panel: ' + label, () => {
    const result = parseNutritionLabel('Serving size 30 g\n' + label);
    assert.equal(result.calories_per_serving, null);
    assert.ok(result.warnings.length);
  });
}

test('does not use servings per container or invalid quantities as serving size', () => {
  for (const line of ['8 servings per container', 'Serving size 0 g', 'Serving size 1/0 cup', 'Serving size half cup']) {
    assert.equal(parseNutritionLabel(line).serving_size_quantity, null);
  }
});
