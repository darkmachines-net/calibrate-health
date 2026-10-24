/** @file Regression coverage for shared product: shared product contract exposes hosted identity and origin-aware trust destinations. */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CALIBRATE_HOSTED_ORIGIN,
  CALIBRATE_PRODUCT_LINKS,
  CALIBRATE_PRODUCT_NAME,
  CALIBRATE_PROJECT_URL
} = require('../../shared/product');

test('shared product contract exposes hosted identity and origin-aware trust destinations', () => {
  assert.equal(CALIBRATE_PRODUCT_NAME, 'Calibrate');
  assert.equal(CALIBRATE_HOSTED_ORIGIN, 'https://calibratehealth.app');
  assert.equal(CALIBRATE_PROJECT_URL, 'https://github.com/MChartier/calibrate-health');
  assert.deepEqual(CALIBRATE_PRODUCT_LINKS, {
    product: CALIBRATE_HOSTED_ORIGIN,
    support: '/support',
    feedback: '/support',
    privacy: '/privacy',
    terms: '/terms',
    licenses: `${CALIBRATE_PROJECT_URL}/blob/master/LICENSE`,
    releases: `${CALIBRATE_PROJECT_URL}/releases`
  });
});
