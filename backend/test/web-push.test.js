/** @file Regression coverage for Web Push SSRF destination validation, DNS lookup filtering, and request timeouts. */

const test = require('node:test');
const assert = require('node:assert/strict');
const webpush = require('web-push');
const {
  createSafeWebPushLookup,
  isPublicRoutableIpAddress,
  sendWebPushNotification,
  validateWebPushEndpoint
} = require('../src/services/webPush');

test('isPublicRoutableIpAddress blocks private, loopback, link-local, metadata, and mapped addresses', () => {
  for (const blocked of [
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    '192.0.2.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '::ffff:10.0.0.5',
    '64:ff9b::127.0.0.1',
    '2002:7f00:0001::1'
  ]) {
    assert.equal(isPublicRoutableIpAddress(blocked), false, blocked);
  }

  for (const allowed of [
    '8.8.8.8',
    '142.250.190.78',
    '1.1.1.1',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '::ffff:8.8.8.8'
  ]) {
    assert.equal(isPublicRoutableIpAddress(allowed), true, allowed);
  }
});

test('validateWebPushEndpoint requires standard-port HTTPS public hostnames', () => {
  assert.equal(validateWebPushEndpoint('https://fcm.googleapis.com/fcm/send/abc').ok, true);
  assert.equal(validateWebPushEndpoint('https://updates.push.services.mozilla.com:443/wpush/v2/abc').ok, true);

  for (const invalid of [
    '',
    'not-a-url',
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://127.0.0.1/push',
    'https://169.254.169.254/latest/meta-data/',
    'https://[::1]/push',
    'https://localhost/push',
    'https://foo.localhost/push',
    'https://service.local/push',
    'https://metadata.google.internal/computeMetadata/v1/',
    'https://postgres/push',
    'https://fcm.googleapis.com:8443/fcm/send/abc',
    'https://user:pass@fcm.googleapis.com/fcm/send/abc'
  ]) {
    assert.equal(validateWebPushEndpoint(invalid).ok, false, invalid);
  }
});

test('createSafeWebPushLookup rejects hostnames resolving to any private or metadata IP', async () => {
  const blockedLookup = createSafeWebPushLookup(async () => [
    { address: '142.250.190.78', family: 4 },
    { address: '169.254.169.254', family: 4 }
  ]);
  await assert.rejects(
    () => new Promise((resolve, reject) => {
      blockedLookup('rebinding.example.com', {}, (err, address) => (err ? reject(err) : resolve(address)));
    }),
    /non-public IP/
  );

  const publicLookup = createSafeWebPushLookup(async () => [
    { address: '142.250.190.78', family: 4 }
  ]);
  const resolved = await new Promise((resolve, reject) => {
    publicLookup('fcm.googleapis.com', {}, (err, address, family) => (err ? reject(err) : resolve({ address, family })));
  });
  assert.deepEqual(resolved, { address: '142.250.190.78', family: 4 });
});

test('sendWebPushNotification blocks unsafe endpoints and enforces bounded request timeout', async () => {
  const prevPublic = process.env.WEB_PUSH_PUBLIC_KEY;
  const prevPrivate = process.env.WEB_PUSH_PRIVATE_KEY;
  const prevSubject = process.env.WEB_PUSH_SUBJECT;
  const originalSetVapid = webpush.setVapidDetails;
  const originalSend = webpush.sendNotification;
  try {
    process.env.WEB_PUSH_PUBLIC_KEY = 'public-key';
    process.env.WEB_PUSH_PRIVATE_KEY = 'private-key';
    process.env.WEB_PUSH_SUBJECT = 'mailto:ops@calibratehealth.app';
    webpush.setVapidDetails = () => {};

    let sendInvoked = false;
    let capturedOptions = null;
    webpush.sendNotification = (_sub, _payload, options) => {
      sendInvoked = true;
      capturedOptions = options;
      return new Promise(() => {});
    };

    await assert.rejects(
      () => sendWebPushNotification({ endpoint: 'http://169.254.169.254/meta', keys: { p256dh: 'k', auth: 'a' } }, '{}'),
      /HTTPS/
    );
    assert.equal(sendInvoked, false);

    await assert.rejects(
      () => sendWebPushNotification(
        { endpoint: 'https://fcm.googleapis.com/fcm/send/slow', keys: { p256dh: 'k', auth: 'a' } },
        '{}',
        { timeoutMs: 25 }
      ),
      /timed out/
    );
    assert.equal(sendInvoked, true);
    assert.equal(capturedOptions.timeout, 25);
    assert.ok(capturedOptions.agent);
  } finally {
    webpush.setVapidDetails = originalSetVapid;
    webpush.sendNotification = originalSend;
    if (prevPublic === undefined) delete process.env.WEB_PUSH_PUBLIC_KEY;
    else process.env.WEB_PUSH_PUBLIC_KEY = prevPublic;
    if (prevPrivate === undefined) delete process.env.WEB_PUSH_PRIVATE_KEY;
    else process.env.WEB_PUSH_PRIVATE_KEY = prevPrivate;
    if (prevSubject === undefined) delete process.env.WEB_PUSH_SUBJECT;
    else process.env.WEB_PUSH_SUBJECT = prevSubject;
  }
});
