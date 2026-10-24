/** @file Regression coverage for open food facts provider: OpenFoodFactsProvider normalizes barcode lookups (nutrients + measures + scaled nutrients). */

const test = require('node:test');
const assert = require('node:assert/strict');

const OpenFoodFactsProvider = require('../src/services/foodData/openFoodFactsProvider').default;

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

test('OpenFoodFactsProvider normalizes barcode lookups (nutrients + measures + scaled nutrients)', async () => {
  const originalFetch = globalThis.fetch;

  const previousTimeout = process.env.OFF_TIMEOUT_MS;
  const previousMode = process.env.OFF_SEARCH_MODE;
  process.env.OFF_TIMEOUT_MS = '0';
  process.env.OFF_SEARCH_MODE = 'auto';

  const provider = new OpenFoodFactsProvider();

  if (previousTimeout === undefined) delete process.env.OFF_TIMEOUT_MS;
  else process.env.OFF_TIMEOUT_MS = previousTimeout;
  if (previousMode === undefined) delete process.env.OFF_SEARCH_MODE;
  else process.env.OFF_SEARCH_MODE = previousMode;

  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));

    return createJsonResponse({
      status: 1,
      product: {
        code: '123',
        product_name: 'Test bar',
        brands: 'Acme',
        lc: 'en',
        serving_size: '30g',
        serving_quantity: 30,
        product_quantity: 100,
        quantity: '100g',
        nutriments: {
          'energy-kcal_100g': 50,
          proteins_100g: 2,
          fat_100g: 1,
          carbohydrates_100g: 10
        }
      }
    });
  };

  try {
    const result = await provider.searchFoods({
      barcode: '123',
      quantityInGrams: 50,
      includeIncomplete: false,
      languageCode: 'en'
    });

    assert.equal(calls.length, 1);
    assert.match(calls[0], /\/api\/v2\/product\/123/);
    assert.match(calls[0], /lc=en/);

    assert.equal(result.items.length, 1);
    const item = result.items[0];
    assert.equal(item.source, 'openFoodFacts');
    assert.equal(item.barcode, '123');
    assert.equal(item.description, 'Test bar');
    assert.equal(item.brand, 'Acme');

    assert.deepEqual(item.nutrientsPer100g, {
      calories: 50,
      protein: 2,
      fat: 1,
      carbs: 10
    });

    assert.equal(item.nutrientsForRequest.grams, 50);
    assert.equal(item.nutrientsForRequest.nutrients.calories, 25);

    const labels = item.availableMeasures.map((m) => m.label);
    assert.equal(labels.includes('per 100g'), true);
    assert.equal(labels.includes('per serving (30g)'), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenFoodFactsProvider omits incomplete products when includeIncomplete=false', async () => {
  const originalFetch = globalThis.fetch;

  const previousTimeout = process.env.OFF_TIMEOUT_MS;
  process.env.OFF_TIMEOUT_MS = '0';
  const provider = new OpenFoodFactsProvider();
  if (previousTimeout === undefined) delete process.env.OFF_TIMEOUT_MS;
  else process.env.OFF_TIMEOUT_MS = previousTimeout;

  globalThis.fetch = async () => {
    return createJsonResponse({
      status: 1,
      product: {
        code: '123',
        product_name: 'Unknown calories',
        nutriments: {}
      }
    });
  };

  try {
    const result = await provider.searchFoods({ barcode: '123', includeIncomplete: false });
    assert.deepEqual(result, { items: [] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenFoodFactsProvider (auto mode) falls back to legacy search when v2 yields no matches', async () => {
  const originalFetch = globalThis.fetch;

  const previousTimeout = process.env.OFF_TIMEOUT_MS;
  const previousMode = process.env.OFF_SEARCH_MODE;
  process.env.OFF_TIMEOUT_MS = '0';
  process.env.OFF_SEARCH_MODE = 'auto';
  const provider = new OpenFoodFactsProvider();
  if (previousTimeout === undefined) delete process.env.OFF_TIMEOUT_MS;
  else process.env.OFF_TIMEOUT_MS = previousTimeout;
  if (previousMode === undefined) delete process.env.OFF_SEARCH_MODE;
  else process.env.OFF_SEARCH_MODE = previousMode;

  const calls = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    calls.push(href);

    if (href.includes('/api/v2/search')) {
      return createJsonResponse({
        products: [
          {
            code: '999',
            product_name: 'Orange',
            brands: 'FruitCo',
            nutriments: { 'energy-kcal_100g': 10 }
          }
        ]
      });
    }

    if (href.includes('/cgi/search.pl')) {
      return createJsonResponse({
        products: [
          {
            code: '111',
            product_name: 'Apple juice',
            brands: 'JuiceCo',
            nutriments: { 'energy-kcal_100g': 40 }
          }
        ]
      });
    }

    throw new Error(`Unexpected URL: ${href}`);
  };

  try {
    const result = await provider.searchFoods({ query: 'apple', includeIncomplete: false });
    assert.equal(calls.some((href) => href.includes('/api/v2/search')), true);
    assert.equal(calls.some((href) => href.includes('/cgi/search.pl')), true);

    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].description.toLowerCase().includes('apple'), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenFoodFactsProvider (legacy mode) filters and ranks search results by query tokens', async () => {
  const originalFetch = globalThis.fetch;

  const previousTimeout = process.env.OFF_TIMEOUT_MS;
  const previousMode = process.env.OFF_SEARCH_MODE;
  process.env.OFF_TIMEOUT_MS = '0';
  process.env.OFF_SEARCH_MODE = 'legacy';
  const provider = new OpenFoodFactsProvider();
  if (previousTimeout === undefined) delete process.env.OFF_TIMEOUT_MS;
  else process.env.OFF_TIMEOUT_MS = previousTimeout;
  if (previousMode === undefined) delete process.env.OFF_SEARCH_MODE;
  else process.env.OFF_SEARCH_MODE = previousMode;

  const calls = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    calls.push(href);

    if (!href.includes('/cgi/search.pl')) {
      throw new Error(`Unexpected URL: ${href}`);
    }

    return createJsonResponse({
      products: [
        {
          code: '111',
          product_name: 'Orange juice',
          brands: 'CitrusCo',
          lc: 'en',
          nutriments: { 'energy-kcal_100g': 40 }
        },
        {
          code: '222',
          product_name: 'Apple',
          brands: 'FruitCo',
          lc: 'en',
          nutriments: { 'energy-kcal_100g': 52 }
        },
        {
          code: '333',
          product_name: 'Green Apple Slices',
          brands: 'FruitCo',
          lc: 'en',
          nutriments: { 'energy-kcal_100g': 48 }
        }
      ]
    });
  };

  try {
    const result = await provider.searchFoods({
      query: 'green apple',
      includeIncomplete: false,
      languageCode: 'en'
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].includes('/cgi/search.pl'), true);

    // "orange" should be filtered out; the strongest match should be ranked first.
    assert.equal(result.items.length, 2);
    assert.equal(result.items[0].description, 'Green Apple Slices');
    assert.equal(result.items[1].description, 'Apple');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenFoodFactsProvider (legacy mode) prefers brand+product matches for possessive queries and drops weak product matches", async () => {
  const originalFetch = globalThis.fetch;

  const previousTimeout = process.env.OFF_TIMEOUT_MS;
  const previousMode = process.env.OFF_SEARCH_MODE;
  process.env.OFF_TIMEOUT_MS = '0';
  process.env.OFF_SEARCH_MODE = 'legacy';
  const provider = new OpenFoodFactsProvider();
  if (previousTimeout === undefined) delete process.env.OFF_TIMEOUT_MS;
  else process.env.OFF_TIMEOUT_MS = previousTimeout;
  if (previousMode === undefined) delete process.env.OFF_SEARCH_MODE;
  else process.env.OFF_SEARCH_MODE = previousMode;

  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));

    return createJsonResponse({
      products: [
        {
          code: '111',
          product_name: "TRADER JOE'S, HABANERO HOT SAUCE",
          brands: "TRADER JOE'S",
          lc: 'en',
          nutriments: { 'energy-kcal_100g': 0 }
        },
        {
          code: '222',
          product_name: 'Hot dog, turkey',
          brands: 'GenericCo',
          lc: 'en',
          nutriments: { 'energy-kcal_100g': 200 }
        },
        {
          code: '333',
          product_name: "Trader Joe's Chicken Hot Dog",
          brands: "Trader Joe's",
          lc: 'en',
          nutriments: { 'energy-kcal_100g': 220 }
        }
      ]
    });
  };

  try {
    const result = await provider.searchFoods({
      query: "trader joe's hot dog",
      includeIncomplete: false,
      languageCode: 'en'
    });

    assert.equal(calls.length, 1);
    assert.equal(result.items.length, 2);
    assert.equal(result.items[0].description, "Trader Joe's Chicken Hot Dog");
    assert.equal(result.items[1].description, 'Hot dog, turkey');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenFoodFactsProvider (legacy mode) throws a detailed error for non-OK search responses', async () => {
  const originalFetch = globalThis.fetch;

  const previousTimeout = process.env.OFF_TIMEOUT_MS;
  const previousMode = process.env.OFF_SEARCH_MODE;
  process.env.OFF_TIMEOUT_MS = '0';
  process.env.OFF_SEARCH_MODE = 'legacy';
  const provider = new OpenFoodFactsProvider();
  if (previousTimeout === undefined) delete process.env.OFF_TIMEOUT_MS;
  else process.env.OFF_TIMEOUT_MS = previousTimeout;
  if (previousMode === undefined) delete process.env.OFF_SEARCH_MODE;
  else process.env.OFF_SEARCH_MODE = previousMode;

  globalThis.fetch = async () => createJsonResponse('maintenance', { ok: false, status: 503 });

  try {
    await assert.rejects(
      () => provider.searchFoods({ query: 'apple', includeIncomplete: false }),
      /legacy 503 maintenance/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenFoodFactsProvider (auto mode) attempts a brand-scoped legacy search when v2 returns only generic product matches", async () => {
  const originalFetch = globalThis.fetch;

  const previousTimeout = process.env.OFF_TIMEOUT_MS;
  const previousMode = process.env.OFF_SEARCH_MODE;
  process.env.OFF_TIMEOUT_MS = '0';
  process.env.OFF_SEARCH_MODE = 'auto';
  const provider = new OpenFoodFactsProvider();
  if (previousTimeout === undefined) delete process.env.OFF_TIMEOUT_MS;
  else process.env.OFF_TIMEOUT_MS = previousTimeout;
  if (previousMode === undefined) delete process.env.OFF_SEARCH_MODE;
  else process.env.OFF_SEARCH_MODE = previousMode;

  const calls = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    calls.push(href);

    if (href.includes('/api/v2/search')) {
      return createJsonResponse({
        products: [
          {
            code: '222',
            product_name: 'Hot dog, turkey',
            brands: 'GenericCo',
            lc: 'en',
            nutriments: { 'energy-kcal_100g': 200 }
          }
        ]
      });
    }

    if (href.includes('/cgi/search.pl')) {
      // This call should include a brand tag filter for "trader joe's".
      return createJsonResponse({
        products: [
          {
            code: '333',
            product_name: "Trader Joe's Chicken Hot Dog",
            brands: "Trader Joe's",
            lc: 'en',
            nutriments: { 'energy-kcal_100g': 220 }
          }
        ]
      });
    }

    throw new Error(`Unexpected URL: ${href}`);
  };

  try {
    const result = await provider.searchFoods({ query: "trader joe's hot dog", includeIncomplete: false, languageCode: 'en' });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].includes('/api/v2/search'), true);
    assert.equal(calls[1].includes('/cgi/search.pl'), true);
    assert.equal(calls[1].includes('tagtype_0=brands'), true);
    assert.equal(calls[1].includes('tag_contains_0=contains'), true);
    assert.equal(calls[1].includes('tag_0=trader-joe'), true);
    assert.equal(calls[1].includes('search_terms=hot+dog'), true);

    assert.equal(result.items.length, 2);
    assert.equal(result.items[0].description, "Trader Joe's Chicken Hot Dog");
    assert.equal(result.items[1].description, 'Hot dog, turkey');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenFoodFactsProvider (v2 mode) surfaces timeout failures', async () => {
  const originalFetch = globalThis.fetch;

  const previousTimeout = process.env.OFF_TIMEOUT_MS;
  const previousMode = process.env.OFF_SEARCH_MODE;
  process.env.OFF_TIMEOUT_MS = '1';
  process.env.OFF_SEARCH_MODE = 'v2';
  const provider = new OpenFoodFactsProvider();
  if (previousTimeout === undefined) delete process.env.OFF_TIMEOUT_MS;
  else process.env.OFF_TIMEOUT_MS = previousTimeout;
  if (previousMode === undefined) delete process.env.OFF_SEARCH_MODE;
  else process.env.OFF_SEARCH_MODE = previousMode;

  let sawSignal = false;
  globalThis.fetch = async (_url, options) => {
    const signal = options?.signal;
    sawSignal = Boolean(signal);

    return await new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  };

  try {
    await assert.rejects(
      () => provider.searchFoods({ query: 'apple', includeIncomplete: false }),
      /v2 request timed out after 1ms/
    );
    assert.equal(sawSignal, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenFoodFactsProvider (auto mode) throws combined errors when v2 errors and legacy fails', async () => {
  const originalFetch = globalThis.fetch;

  const previousTimeout = process.env.OFF_TIMEOUT_MS;
  const previousMode = process.env.OFF_SEARCH_MODE;
  process.env.OFF_TIMEOUT_MS = '0';
  process.env.OFF_SEARCH_MODE = 'auto';
  const provider = new OpenFoodFactsProvider();
  if (previousTimeout === undefined) delete process.env.OFF_TIMEOUT_MS;
  else process.env.OFF_TIMEOUT_MS = previousTimeout;
  if (previousMode === undefined) delete process.env.OFF_SEARCH_MODE;
  else process.env.OFF_SEARCH_MODE = previousMode;

  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('/api/v2/search')) {
      throw new Error('network down');
    }
    if (href.includes('/cgi/search.pl')) {
      return createJsonResponse('legacy down', { ok: false, status: 500 });
    }
    throw new Error(`Unexpected URL: ${href}`);
  };

  try {
    await assert.rejects(
      () => provider.searchFoods({ query: 'apple', includeIncomplete: false }),
      /v2 network down; legacy 500 legacy down/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenFoodFactsProvider (auto mode) avoids legacy fallback when v2 finds query matches', async () => {
  const originalFetch = globalThis.fetch;

  const previousTimeout = process.env.OFF_TIMEOUT_MS;
  const previousMode = process.env.OFF_SEARCH_MODE;
  process.env.OFF_TIMEOUT_MS = '0';
  process.env.OFF_SEARCH_MODE = 'auto';
  const provider = new OpenFoodFactsProvider();
  if (previousTimeout === undefined) delete process.env.OFF_TIMEOUT_MS;
  else process.env.OFF_TIMEOUT_MS = previousTimeout;
  if (previousMode === undefined) delete process.env.OFF_SEARCH_MODE;
  else process.env.OFF_SEARCH_MODE = previousMode;

  const calls = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    calls.push(href);

    if (href.includes('/cgi/search.pl')) {
      throw new Error('Unexpected legacy fallback');
    }

    return createJsonResponse({
      products: [
        {
          code: '777',
          product_name: 'Apple pie',
          brands: 'BakeryCo',
          lc: 'en',
          nutriments: { 'energy-kcal_100g': 200 }
        }
      ]
    });
  };

  try {
    const result = await provider.searchFoods({ query: 'apple', includeIncomplete: false });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].includes('/api/v2/search'), true);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].description, 'Apple pie');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenFoodFactsProvider includes incomplete barcode products when includeIncomplete=true', async () => {
  const originalFetch = globalThis.fetch;

  const previousTimeout = process.env.OFF_TIMEOUT_MS;
  process.env.OFF_TIMEOUT_MS = '0';
  const provider = new OpenFoodFactsProvider();
  if (previousTimeout === undefined) delete process.env.OFF_TIMEOUT_MS;
  else process.env.OFF_TIMEOUT_MS = previousTimeout;

  globalThis.fetch = async () =>
    createJsonResponse({
      status: 1,
      product: {
        code: '123',
        product_name: 'Mystery snack',
        nutriments: {}
      }
    });

  try {
    const result = await provider.searchFoods({ barcode: '123', includeIncomplete: true });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].description, 'Mystery snack');
    assert.equal(result.items[0].nutrientsPer100g, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenFoodFactsProvider extracts nutrients from energy_100g and parses serving_size units', async () => {
  const originalFetch = globalThis.fetch;

  const previousTimeout = process.env.OFF_TIMEOUT_MS;
  process.env.OFF_TIMEOUT_MS = '0';
  const provider = new OpenFoodFactsProvider();
  if (previousTimeout === undefined) delete process.env.OFF_TIMEOUT_MS;
  else process.env.OFF_TIMEOUT_MS = previousTimeout;

  globalThis.fetch = async () =>
    createJsonResponse({
      status: 1,
      product: {
        code: '321',
        product_name: 'Test cereal',
        brands: 'Acme',
        lc: 'en',
        serving_size: '2 oz',
        product_quantity: '250',
        quantity: '250g',
        nutriments: {
          // 418.4 / 4.184 = 100 kcal/100g
          'energy_100g': 418.4,
          proteins_100g: '1.234',
          fat_100g: 2.345,
          carbohydrates_100g: 3.456
        }
      }
    });

  try {
    const result = await provider.searchFoods({
      barcode: '321',
      includeIncomplete: false,
      quantityInGrams: 50
    });

    assert.equal(result.items.length, 1);
    const item = result.items[0];

    assert.deepEqual(item.nutrientsPer100g, {
      calories: 100,
      protein: 1.23,
      fat: 2.35,
      carbs: 3.46
    });

    const servingMeasure = item.availableMeasures.find((m) => m.label === 'per serving (2 oz)');
    assert.equal(servingMeasure?.gramWeight, 56.7);

    const packageMeasure = item.availableMeasures.find((m) => m.label === '250g');
    assert.equal(packageMeasure?.gramWeight, 250);

    assert.equal(item.nutrientsForRequest.grams, 50);
    assert.equal(item.nutrientsForRequest.nutrients.calories, 50);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenFoodFactsProvider returns empty results when the upstream payload has no products list', async () => {
  const originalFetch = globalThis.fetch;

  const previousTimeout = process.env.OFF_TIMEOUT_MS;
  const previousMode = process.env.OFF_SEARCH_MODE;
  process.env.OFF_TIMEOUT_MS = '0';
  process.env.OFF_SEARCH_MODE = 'legacy';
  const provider = new OpenFoodFactsProvider();
  if (previousTimeout === undefined) delete process.env.OFF_TIMEOUT_MS;
  else process.env.OFF_TIMEOUT_MS = previousTimeout;
  if (previousMode === undefined) delete process.env.OFF_SEARCH_MODE;
  else process.env.OFF_SEARCH_MODE = previousMode;

  globalThis.fetch = async () => createJsonResponse({ products: null });

  try {
    const result = await provider.searchFoods({ query: 'apple', includeIncomplete: false });
    assert.deepEqual(result, { items: [] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
