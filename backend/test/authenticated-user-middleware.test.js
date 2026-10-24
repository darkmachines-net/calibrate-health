/** @file Regression coverage for authenticated user middleware: authenticated user middleware accepts a hydrated principal. */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getAuthenticatedUser,
  requireAuthenticatedUser
} = require('../src/middleware/authenticatedUser');

function responseRecorder() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

test('authenticated user middleware accepts a hydrated principal', () => {
  const user = { id: 7, timezone: 'UTC', weight_unit: 'KG', height_unit: 'CM' };
  const req = { isAuthenticated: () => true, user };
  const res = responseRecorder();
  let calledNext = false;

  requireAuthenticatedUser(req, res, () => {
    calledNext = true;
  });

  assert.equal(calledNext, true);
  assert.equal(getAuthenticatedUser(req), user);
});

test('authenticated user middleware rejects missing or malformed principals', () => {
  for (const user of [
    undefined,
    null,
    {},
    { id: 0 },
    { id: -1 },
    { id: 1.5 },
    { id: '7' }
  ]) {
    const req = { isAuthenticated: () => true, user };
    const res = responseRecorder();
    let calledNext = false;

    requireAuthenticatedUser(req, res, () => {
      calledNext = true;
    });

    assert.equal(calledNext, false);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { message: 'Not authenticated' });
  }
});

test('getAuthenticatedUser fails closed when a route omits its guard', () => {
  assert.throws(
    () => getAuthenticatedUser({ user: undefined }),
    /missing a valid user principal/
  );
});
