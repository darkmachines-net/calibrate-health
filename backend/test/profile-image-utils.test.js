/** @file Regression coverage for profile image utils: profileImage: allowed MIME types include the expected image formats. */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ALLOWED_PROFILE_IMAGE_MIME_TYPES,
  buildBase64DataUrl,
  parseBase64DataUrl
} = require('../src/utils/profileImage');

test('profileImage: allowed MIME types include the expected image formats', () => {
  assert.equal(ALLOWED_PROFILE_IMAGE_MIME_TYPES.has('image/png'), true);
  assert.equal(ALLOWED_PROFILE_IMAGE_MIME_TYPES.has('image/jpeg'), true);
  assert.equal(ALLOWED_PROFILE_IMAGE_MIME_TYPES.has('image/webp'), true);

  assert.equal(ALLOWED_PROFILE_IMAGE_MIME_TYPES.has('image/gif'), false);
  assert.equal(ALLOWED_PROFILE_IMAGE_MIME_TYPES.has('IMAGE/PNG'), false);
});

test('profileImage: parseBase64DataUrl rejects malformed strings', () => {
  const invalidInputs = [
    '',
    'not-a-data-url',
    'data:image/png;base64', // missing comma + payload
    'data:image/png;base64,', // empty payload -> empty bytes
    'data:image/png;base64,***', // invalid base64 chars
    'data:image/gif;base64,R0lGODlhAQABAAAAACw=' // unsupported MIME type
  ];

  for (const input of invalidInputs) {
    assert.equal(parseBase64DataUrl(input), null);
  }
});

test('profileImage: parseBase64DataUrl parses supported base64 data URLs (trimming whitespace)', () => {
  const dataUrl = '  data:image/png;base64,AQID  ';
  const parsed = parseBase64DataUrl(dataUrl);
  assert.ok(parsed);
  assert.equal(parsed.mimeType, 'image/png');
  assert.deepEqual(Array.from(parsed.bytes), [1, 2, 3]);
});

test('profileImage: buildBase64DataUrl encodes bytes and round-trips with parseBase64DataUrl', () => {
  const bytes = new Uint8Array([0, 255, 16, 32]);
  const dataUrl = buildBase64DataUrl({ mimeType: 'image/png', bytes });

  assert.equal(dataUrl, 'data:image/png;base64,AP8QIA==');

  const parsed = parseBase64DataUrl(dataUrl);
  assert.ok(parsed);
  assert.equal(parsed.mimeType, 'image/png');
  assert.deepEqual(Array.from(parsed.bytes), Array.from(bytes));
});

