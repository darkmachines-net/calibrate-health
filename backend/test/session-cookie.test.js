/** @file Regression coverage for session cookie: clearing a session cookie preserves its configured domain. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { clearSessionCookie } = require('../src/utils/sessionCookie');

test('clearing a session cookie preserves its configured domain', () => {
  const previousName = process.env.SESSION_COOKIE_NAME;
  const previousDomain = process.env.SESSION_COOKIE_DOMAIN;
  process.env.SESSION_COOKIE_NAME = 'calibrate.sid';
  process.env.SESSION_COOKIE_DOMAIN = '.example.test';
  try {
    let cleared = null;
    clearSessionCookie({ clearCookie: (name, options) => { cleared = { name, options }; } });
    assert.deepEqual(cleared, {
      name: 'calibrate.sid',
      options: { path: '/', domain: '.example.test' }
    });
  } finally {
    if (previousName === undefined) delete process.env.SESSION_COOKIE_NAME;
    else process.env.SESSION_COOKIE_NAME = previousName;
    if (previousDomain === undefined) delete process.env.SESSION_COOKIE_DOMAIN;
    else process.env.SESSION_COOKIE_DOMAIN = previousDomain;
  }
});
