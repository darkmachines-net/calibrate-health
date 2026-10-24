/** @file Regression coverage for nutrition label: label scans send authenticated multipart data to the versioned API and leave null fields intact. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { CalibrateApiClient } from '../src/client.ts';
import type { NutritionLabelDraft } from '../src/types.ts';

test('label scans send authenticated multipart data to the versioned API and leave null fields intact', async () => {
    let request: RequestInit | undefined;
    const draft: NutritionLabelDraft = {
        calories_per_serving: null, serving_size_quantity: 0.5, serving_unit_label: 'cup (40 g)',
        serving_text: '1/2 cup (40 g)', warnings: ['Check calories.']
    };
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        getAccessToken: async () => 'test-token',
        fetchImpl: (async (url, init) => {
            assert.equal(String(url), 'https://calibrate.example/api/v1/nutrition-labels/scan');
            request = init;
            return new Response(JSON.stringify(draft), { status: 200 });
        }) as typeof fetch
    });
    assert.deepEqual(await client.scanNutritionLabel(new Blob(['image'], { type: 'image/png' })), draft);
    assert.equal(request?.method, 'POST');
    assert.equal(new Headers(request?.headers).get('authorization'), 'Bearer test-token');
    assert.equal(new Headers(request?.headers).get('content-type'), null);
    assert.ok(request?.body instanceof FormData);
    assert.equal(await (request.body.get('image') as Blob).text(), 'image');
    assert.ok(!('timeoutMs' in request));
});
