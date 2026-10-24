/** @file Regression coverage for account access: account access prioritizes email verification before legal acceptance. */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CURRENT_ACCOUNT_ACCESS_WHERE,
  serializeAccountAccess
} = require('../src/utils/accountAccessSerialization');

const currentAcceptance = {
  terms_version: '2026-08-09',
  privacy_version: '2026-07-24',
  accepted_at: new Date('2026-08-09T00:00:00.000Z')
};

test('account access prioritizes email verification before legal acceptance', () => {
  assert.deepEqual(
    serializeAccountAccess({ email_verified_at: null, legal_acceptances: [currentAcceptance] }),
    { state: 'email_verification_required', email_verified: false, legal_current: true }
  );
});

test('hosted account access requires current legal versions after verification', () => {
  const previous = { NODE_ENV: process.env.NODE_ENV, CALIBRATE_HOSTED_SERVICE: process.env.CALIBRATE_HOSTED_SERVICE };
  process.env.NODE_ENV = 'production';
  process.env.CALIBRATE_HOSTED_SERVICE = 'true';
  try {
    assert.deepEqual(
      serializeAccountAccess({ email_verified_at: new Date(), legal_acceptances: [] }),
      { state: 'legal_acceptance_required', email_verified: true, legal_current: false }
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('self-hosted account access does not require Calibrate hosted-service consent', () => {
  assert.deepEqual(
    serializeAccountAccess({ email_verified_at: new Date(), legal_acceptances: [] }),
    { state: 'full', email_verified: true, legal_current: true }
  );
});

test('account access is full only when verification and current consent are present', () => {
  assert.deepEqual(
    serializeAccountAccess({ email_verified_at: new Date(), legal_acceptances: [currentAcceptance] }),
    { state: 'full', email_verified: true, legal_current: true }
  );
  assert.deepEqual(serializeAccountAccess({}), {
    state: 'full',
    email_verified: true,
    legal_current: true
  });
});
test('self-hosted background jobs require verification without hosted legal consent', () => {
  assert.deepEqual(CURRENT_ACCOUNT_ACCESS_WHERE, {
    email_verified_at: { not: null }
  });
});
