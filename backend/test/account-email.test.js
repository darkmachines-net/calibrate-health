/** @file Regression coverage for account email: hosted deployed registration requires configured account email. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { CALIBRATE_HOSTED_ORIGIN } = require('../../shared/product');

const {
  EMAIL_DELIVERY_MODES,
  isEmailVerificationRequired,
  resolveEmailDeliveryConfig
} = require('../src/config/emailDelivery');
const {
  buildAccountEmailMessage,
  deliverAccountEmail,
  resetAccountEmailTransportForTests
} = require('../src/services/accountEmail');

test('hosted deployed registration requires configured account email', () => {
  const config = resolveEmailDeliveryConfig({
    NODE_ENV: 'production',
    CALIBRATE_HOSTED_SERVICE: 'true',
    EMAIL_DELIVERY_MODE: 'disabled'
  });
  assert.equal(config.mode, EMAIL_DELIVERY_MODES.DISABLED);
  assert.equal(config.hostedRequired, true);
  assert.equal(config.publicAppOrigin, CALIBRATE_HOSTED_ORIGIN);
  assert.equal(isEmailVerificationRequired(config), true);
});

test('self-hosted deployments may preserve registration without SMTP', () => {
  const config = resolveEmailDeliveryConfig({ NODE_ENV: 'production' });
  assert.equal(config.mode, EMAIL_DELIVERY_MODES.DISABLED);
  assert.equal(config.hostedRequired, false);
  assert.equal(isEmailVerificationRequired(config), false);
});

test('SMTP configuration requires a complete provider-neutral transport', () => {
  const config = resolveEmailDeliveryConfig({
    NODE_ENV: 'production',
    EMAIL_DELIVERY_MODE: 'smtp',
    SMTP_HOST: 'smtp.example.test',
    SMTP_PORT: '465',
    SMTP_SECURE: 'true',
    SMTP_USERNAME: 'account',
    SMTP_PASSWORD: 'secret',
    SMTP_FROM: 'Calibrate <no-reply@example.test>',
    PUBLIC_APP_ORIGIN: 'https://app.example.test/path'
  });
  assert.equal(config.mode, EMAIL_DELIVERY_MODES.SMTP);
  assert.equal(config.publicAppOrigin, 'https://app.example.test');
  assert.equal(config.port, 465);
  assert.equal(config.secure, true);
});

test('hosted account links reject a plaintext public origin', () => {
  const config = resolveEmailDeliveryConfig({
    NODE_ENV: 'production',
    CALIBRATE_HOSTED_SERVICE: 'true',
    EMAIL_DELIVERY_MODE: 'smtp',
    SMTP_HOST: 'smtp.example.test',
    SMTP_FROM: 'no-reply@example.test',
    PUBLIC_APP_ORIGIN: 'http://calibratehealth.app'
  });
  assert.equal(config.mode, EMAIL_DELIVERY_MODES.DISABLED);
  assert.equal(config.hostedRequired, true);
});

test('account links keep credentials out of query strings and referrers', () => {
  const config = {
    mode: 'smtp',
    hostedRequired: true,
    publicAppOrigin: 'https://calibratehealth.app',
    host: 'smtp.example.test',
    port: 587,
    secure: false,
    username: null,
    password: null,
    from: 'no-reply@example.test'
  };
  const message = buildAccountEmailMessage({
    kind: 'email_verification',
    recipient: 'private@example.test',
    token: 'opaque+/token'
  }, config);
  assert.match(message.text, /\/verify-email#token=opaque%2B%2Ftoken/);
  assert.doesNotMatch(message.text, /\?token=/);
});
test('equivalent resolved SMTP settings reuse one transport', async () => {
  const nodemailer = require('nodemailer');
  const originalCreateTransport = nodemailer.createTransport;
  let transportCreations = 0;
  nodemailer.createTransport = () => {
    transportCreations += 1;
    return { sendMail: async () => undefined };
  };
  const config = {
    mode: 'smtp',
    hostedRequired: true,
    publicAppOrigin: 'https://calibratehealth.app',
    host: 'smtp.example.test',
    port: 587,
    secure: false,
    username: 'account',
    password: 'secret',
    from: 'no-reply@example.test'
  };

  resetAccountEmailTransportForTests();
  try {
    await deliverAccountEmail({
      kind: 'email_verification', recipient: 'first@example.test', token: 'token-1'
    }, { ...config });
    await deliverAccountEmail({
      kind: 'password_reset', recipient: 'second@example.test', token: 'token-2'
    }, { ...config });
    assert.equal(transportCreations, 1);
  } finally {
    resetAccountEmailTransportForTests();
    nodemailer.createTransport = originalCreateTransport;
  }
});

test('installed Nodemailer composes verification and recovery messages without sending email', async () => {
  const nodemailer = require('nodemailer');
  const originalCreateTransport = nodemailer.createTransport;
  const messages = [];
  const transport = originalCreateTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  nodemailer.createTransport = () => ({
    sendMail: async (options) => {
      const message = await transport.sendMail(options);
      messages.push(message);
      return message;
    }
  });
  const config = {
    mode: 'smtp',
    hostedRequired: false,
    publicAppOrigin: 'https://app.example.test',
    host: 'smtp.example.test',
    port: 587,
    secure: false,
    username: null,
    password: null,
    from: 'Calibrate <no-reply@example.test>'
  };

  resetAccountEmailTransportForTests();
  try {
    for (const [kind, route, subject] of [
      ['email_verification', 'verify-email', 'Verify your Calibrate email'],
      ['password_reset', 'reset-password', 'Reset your Calibrate password']
    ]) {
      assert.equal(await deliverAccountEmail({
        kind, recipient: 'member@example.test', token: 'test-token'
      }, config), true);
      const message = messages.at(-1);
      assert.deepEqual(message.envelope, { from: 'no-reply@example.test', to: ['member@example.test'] });
      const text = message.message.toString('utf8');
      assert.ok(text.includes(`Subject: ${subject}`));
      assert.ok(text.includes(`https://app.example.test/${route}#token=test-token`));
    }
  } finally {
    resetAccountEmailTransportForTests();
    nodemailer.createTransport = originalCreateTransport;
    transport.close();
  }
});
