/** @file Regression coverage for food search ranking: food search normalization keeps provider query behavior consistent. */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildFoodSearchQuery,
  buildProductTokenGroups,
  normalizeFoodSearchText,
  scoreProductTokenGroups,
  tokenizeFoodSearchQuery
} = require('../src/services/foodData/searchRanking');

test('food search normalization keeps provider query behavior consistent', () => {
  assert.equal(normalizeFoodSearchText("Trader Joe's Hot Dogs"), 'trader joe hot dogs');
  assert.deepEqual(tokenizeFoodSearchQuery('Berries & hot dogs'), ['berry', 'hot', 'dog']);
});

test('food search token options support provider-specific filtering', () => {
  const stopWords = new Set(['the', 'with']);
  assert.deepEqual(
    tokenizeFoodSearchQuery('the tea with a', { minTokenLength: 2, stopWords }),
    ['tea']
  );
  assert.equal(buildFoodSearchQuery([], 'fallback query'), 'fallback query');
});

test('food search scoring recognizes shared product synonyms', () => {
  const groups = buildProductTokenGroups(['hot', 'dog']);
  assert.equal(scoreProductTokenGroups(new Set(['beef', 'frank']), groups), 100);
  assert.equal(scoreProductTokenGroups(new Set(['hot']), groups), 10);
});
