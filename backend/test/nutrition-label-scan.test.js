/** @file Regression coverage for nutrition label scan: rejects invalid, oversized, vector, and excessive-pixel images. */

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { scanNutritionLabel, MAX_LABEL_IMAGE_BYTES } = require('../src/services/nutritionLabels/scan');

test('rejects invalid, oversized, vector, and excessive-pixel images', async () => {
  await assert.rejects(scanNutritionLabel(Buffer.from('not an image')), { statusCode: 400 });
  await assert.rejects(scanNutritionLabel(Buffer.alloc(MAX_LABEL_IMAGE_BYTES + 1)), { statusCode: 413 });
  await assert.rejects(scanNutritionLabel(Buffer.from('<svg width="100" height="100"></svg>')), { statusCode: 400 });
  const oversized = await sharp({ create: { width: 5100, height: 5100, channels: 3, background: 'white' } }).png().toBuffer();
  await assert.rejects(scanNutritionLabel(oversized), { statusCode: 400 });
});

test('real local OCR extracts a label, bounds concurrency, and releases its worker', { timeout: 60_000 }, async () => {
  // Fixed pixels keep real OCR coverage independent of the host's installed fonts.
  const image = await readFile(path.join(__dirname, 'fixtures/nutrition-label.png'));
  const pending = scanNutritionLabel(image);
  await assert.rejects(scanNutritionLabel(image), { statusCode: 503 });
  const result = await pending;
  assert.equal(result.serving_size_quantity, 2);
  assert.equal(result.serving_unit_label, 'tbsp (32 g)');
  assert.equal(result.calories_per_serving, 190);
  // The next request reaches validation, proving that the scan slot was released.
  await assert.rejects(scanNutritionLabel(Buffer.from('invalid')), { statusCode: 400 });
});

test('cancellation terminates OCR and releases the slot before the deadline', { timeout: 10_000 }, async () => {
  const image = await readFile(path.join(__dirname, 'fixtures/nutrition-label.png'));
  const controller = new AbortController();
  const pending = scanNutritionLabel(image, controller.signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort();
  await rejected;
  // A cancelled request must not block the next user with a busy response.
  await assert.rejects(scanNutritionLabel(Buffer.from('invalid')), { statusCode: 400 });
  await assert.rejects(scanNutritionLabel(image, controller.signal), { name: 'AbortError' });
  await assert.rejects(scanNutritionLabel(Buffer.from('invalid')), { statusCode: 400 });
});
