/** @file Regression coverage for usda food data provider: UsdaFoodDataProvider normalizes search results (measures + nutrients per 100g + scaled nutrients). */

const test = require('node:test');
const assert = require('node:assert/strict');

const UsdaFoodDataProvider = require('../src/services/foodData/usdaFoodDataProvider').default;

function createJsonResponse(data, opts = {}) {
  const status = opts.status ?? 200;
  const ok = opts.ok ?? true;
  return {
    ok,
    status,
    async json() {
      return data;
    },
    async text() {
      return typeof data === 'string' ? data : JSON.stringify(data);
    }
  };
}

test('UsdaFoodDataProvider normalizes search results (measures + nutrients per 100g + scaled nutrients)', async () => {
  const provider = new UsdaFoodDataProvider('test-key');
  const originalFetch = globalThis.fetch;

  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });

    return createJsonResponse({
      foods: [
        {
          fdcId: 1,
          description: 'Test food',
          brandOwner: 'Acme',
          gtinUpc: '012345',
          householdServingFullText: '2 oz',
          servingSize: 2,
          servingSizeUnit: 'oz',
          labelNutrients: {
            calories: { value: 100 },
            protein: { value: 10 },
            fat: { value: 5 },
            carbohydrates: { value: 20 }
          },
          foodPortions: [{ modifier: 'slice', gramWeight: 30 }]
        }
      ]
    });
  };

  try {
    const result = await provider.searchFoods({
      query: 'test',
      page: 2,
      pageSize: 15,
      quantityInGrams: 50,
      includeIncomplete: false
    });

    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/foods\/search\?api_key=test-key/);
    assert.equal(calls[0].options?.method, 'POST');

    const body = JSON.parse(calls[0].options?.body ?? '{}');
    assert.equal(body.query, 'test');
    assert.equal(body.pageSize, 15);
    assert.equal(body.pageNumber, 2);

    assert.equal(result.items.length, 1);
    const item = result.items[0];
    assert.equal(item.source, 'usda');
    assert.equal(item.id, '1');
    assert.equal(item.description, 'Test food');
    assert.equal(item.brand, 'Acme');
    assert.equal(item.barcode, '012345');

    // 2 oz -> 56.7g; factor = 100/56.7 -> 1.7636...
    assert.deepEqual(item.nutrientsPer100g, {
      calories: 176.4,
      protein: 17.64,
      fat: 8.82,
      carbs: 35.27
    });

    assert.equal(item.nutrientsForRequest.grams, 50);
    assert.equal(item.nutrientsForRequest.nutrients.calories, 88.2);

    const labels = item.availableMeasures.map((m) => m.label);
    assert.equal(labels.includes('2 oz'), true);
    assert.equal(labels.includes('slice'), true);
    assert.equal(labels.includes('per 100g'), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('UsdaFoodDataProvider returns empty results when neither query nor barcode is provided', async () => {
  const provider = new UsdaFoodDataProvider('test-key');
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    throw new Error('fetch should not be called');
  };

  try {
    const result = await provider.searchFoods({});
    assert.deepEqual(result, { items: [] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('UsdaFoodDataProvider barcode searches prefer exact gtinUpc matches', async () => {
  const provider = new UsdaFoodDataProvider('test-key');
  const originalFetch = globalThis.fetch;

  const calls = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options?.body ?? '{}');
    calls.push(body);

    return createJsonResponse({
      foods: [
        {
          fdcId: 1,
          description: 'Not the requested barcode',
          gtinUpc: '999',
          householdServingFullText: '100 g',
          servingSize: 100,
          servingSizeUnit: 'g',
          labelNutrients: { calories: { value: 50 } }
        },
        {
          fdcId: 2,
          description: 'Exact match',
          gtinUpc: '012345678905',
          householdServingFullText: '100 g',
          servingSize: 100,
          servingSizeUnit: 'g',
          labelNutrients: { calories: { value: 100 } }
        }
      ]
    });
  };

  try {
    const result = await provider.searchFoods({
      barcode: '01234 567-8905',
      includeIncomplete: false,
      pageSize: 10
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].query, '012345678905');
    // Barcode lookups intentionally fetch more upstream candidates for exact-match filtering.
    assert.equal(calls[0].pageSize, 200);

    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].id, '2');
    assert.equal(result.items[0].barcode, '012345678905');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('UsdaFoodDataProvider requires all words for multi-term queries and falls back when strict results are empty', async () => {
  const provider = new UsdaFoodDataProvider('test-key');
  const originalFetch = globalThis.fetch;

  const calls = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options?.body ?? '{}');
    calls.push(body);

    if (calls.length === 1) {
      // Strict query yields no hits -> provider should retry without requireAllWords.
      return createJsonResponse({ foods: [] });
    }

    return createJsonResponse({
      foods: [{ fdcId: 1, description: 'TRADER JOE HOT DOGS' }]
    });
  };

  try {
    const result = await provider.searchFoods({ query: 'chicken hot dog', includeIncomplete: true });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].requireAllWords, true);
    assert.equal(calls[1].requireAllWords, undefined);

    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].id, '1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("UsdaFoodDataProvider ranking prefers product matches over brand-only matches for possessive brand queries", async () => {
  const provider = new UsdaFoodDataProvider('test-key');
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    createJsonResponse({
      foods: [
        { fdcId: 1, description: "TRADER JOE'S, HABANERO HOT SAUCE", brandOwner: "TRADER JOE'S" },
        { fdcId: 2, description: 'Hot dog, turkey' }
      ]
    });

  try {
    const result = await provider.searchFoods({ query: "trader joe's hot dog", includeIncomplete: true });
    assert.equal(result.items.length, 2);
    assert.equal(result.items[0].description, 'Hot dog, turkey');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('UsdaFoodDataProvider throws a detailed error for non-OK search responses', async () => {
  const provider = new UsdaFoodDataProvider('test-key');
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => createJsonResponse('bad gateway', { ok: false, status: 502 });

  try {
    await assert.rejects(() => provider.searchFoods({ query: 'apple' }), /USDA search failed: 502 bad gateway/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('UsdaFoodDataProvider prefers foodNutrients and converts kJ energy to kcal', async () => {
  const provider = new UsdaFoodDataProvider('test-key');
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    createJsonResponse({
      foods: [
        {
          fdcId: 99,
          description: 'Food Nutrients Example',
          brandName: 'BrandCo',
          gtinUpc: '999',
          // labelNutrients should be ignored once foodNutrients includes energy.
          householdServingFullText: '100 g',
          servingSize: 100,
          servingSizeUnit: 'g',
          labelNutrients: {
            calories: { value: 999 },
            protein: { value: 999 },
            fat: { value: 999 },
            carbohydrates: { value: 999 }
          },
          foodNutrients: [
            { nutrientNumber: '1008', nutrientName: 'Energy', unitName: 'kJ', amount: 418.4 },
            { nutrientNumber: '1003', nutrientName: 'Protein', unitName: 'g', value: 1.5 },
            { nutrientId: 1004, nutrientName: 'Total lipid (fat)', unitName: 'g', amount: 2 },
            { nutrientName: 'Carbohydrate, by difference', unitName: 'g', amount: 3 }
          ]
        }
      ]
    });

  try {
    const result = await provider.searchFoods({ query: 'test', includeIncomplete: false, quantityInGrams: 50 });
    assert.equal(result.items.length, 1);

    const item = result.items[0];
    assert.equal(item.source, 'usda');
    assert.equal(item.id, '99');
    assert.equal(item.description, 'Food Nutrients Example');
    assert.equal(item.brand, 'BrandCo');
    assert.equal(item.barcode, '999');

    assert.deepEqual(item.nutrientsPer100g, {
      calories: 100,
      protein: 1.5,
      fat: 2,
      carbs: 3
    });

    assert.equal(item.nutrientsForRequest.grams, 50);
    assert.equal(item.nutrientsForRequest.nutrients.calories, 50);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('UsdaFoodDataProvider omits foods without usable nutrients when includeIncomplete=false', async () => {
  const provider = new UsdaFoodDataProvider('test-key');
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    createJsonResponse({
      foods: [
        {
          fdcId: 123,
          description: 'No convertible serving size',
          householdServingFullText: '1 cup',
          servingSize: 1,
          servingSizeUnit: 'cup',
          labelNutrients: { calories: { value: 100 } }
        }
      ]
    });

  try {
    const result = await provider.searchFoods({ query: 'test', includeIncomplete: false });
    assert.deepEqual(result, { items: [] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('UsdaFoodDataProvider includes incomplete foods when includeIncomplete=true', async () => {
  const provider = new UsdaFoodDataProvider('test-key');
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    createJsonResponse({
      foods: [
        {
          fdcId: 456,
          description: 'No convertible serving size',
          householdServingFullText: '1 cup',
          servingSize: 1,
          servingSizeUnit: 'cup',
          labelNutrients: { calories: { value: 100 } }
        }
      ]
    });

  try {
    const result = await provider.searchFoods({ query: 'test', includeIncomplete: true });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].id, '456');
    assert.equal(result.items[0].nutrientsPer100g, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('UsdaFoodDataProvider converts kilogram serving sizes to gram weights', async () => {
  const provider = new UsdaFoodDataProvider('test-key');
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    createJsonResponse({
      foods: [
        {
          fdcId: 777,
          description: 'Kilogram serving',
          householdServingFullText: '0.1 kg',
          servingSize: 0.1,
          servingSizeUnit: 'kg',
          labelNutrients: {
            calories: { value: 200 },
            protein: { value: 10 }
          }
        }
      ]
    });

  try {
    const result = await provider.searchFoods({ query: 'kg', includeIncomplete: false });
    assert.equal(result.items.length, 1);

    // 0.1kg -> 100g, so nutrients should already be per 100g.
    assert.deepEqual(result.items[0].nutrientsPer100g, {
      calories: 200,
      protein: 10,
      fat: undefined,
      carbs: undefined
    });

    const servingMeasure = result.items[0].availableMeasures.find((m) => m.label === '0.1 kg');
    assert.equal(servingMeasure?.gramWeight, 100);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
