/** @file Regression coverage for user serialization: userSerialization: USER_CLIENT_SELECT does not include sensitive columns. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { ActivityLevel, HeightUnit, Sex, WeightUnit } = require('@prisma/client');

const { serializeUserForClient, USER_CLIENT_SELECT } = require('../src/utils/userSerialization');

test('userSerialization: USER_CLIENT_SELECT does not include sensitive columns', () => {
  assert.equal('password_hash' in USER_CLIENT_SELECT, false);
});

test('userSerialization: serializeUserForClient omits profile_image_url when bytes or mimeType are missing', () => {
  const baseUser = {
    id: 1,
    email: 'someone@example.com',
    created_at: new Date('2025-01-01T12:00:00Z'),
    onboarding_completed_at: null,
    weight_unit: WeightUnit.KG,
    height_unit: HeightUnit.CM,
    timezone: 'UTC',
    reminder_log_weight_enabled: true,
    reminder_log_food_enabled: true,
    haptics_enabled: true,
    date_of_birth: null,
    sex: Sex.MALE,
    height_mm: 1750,
    activity_level: ActivityLevel.MODERATE
  };

  assert.equal(
    serializeUserForClient({ ...baseUser, profile_image: null, profile_image_mime_type: 'image/png' })
      .profile_image_url,
    null
  );

  assert.equal(
    serializeUserForClient({ ...baseUser, profile_image: new Uint8Array([1, 2, 3]), profile_image_mime_type: null })
      .profile_image_url,
    null
  );

  assert.equal(serializeUserForClient(baseUser).profile_image_url, null);
});

test('userSerialization: serializeUserForClient builds a base64 data URL when image bytes and mimeType are present', () => {
  const user = {
    id: 42,
    email: 'test@example.com',
    created_at: new Date('2025-01-01T12:00:00Z'),
    onboarding_completed_at: new Date('2025-01-02T12:00:00Z'),
    weight_unit: WeightUnit.LB,
    height_unit: HeightUnit.FT_IN,
    timezone: 'America/Los_Angeles',
    reminder_log_weight_enabled: true,
    reminder_log_food_enabled: false,
    reminder_log_weight_minute: 450,
    reminder_log_food_minute: 1_155,
    reminder_quiet_hours_start_minute: 1_320,
    reminder_quiet_hours_end_minute: 360,
    haptics_enabled: true,
    date_of_birth: new Date('1990-01-15T00:00:00Z'),
    sex: Sex.FEMALE,
    height_mm: 1650,
    activity_level: ActivityLevel.LIGHT,
    profile_image: new Uint8Array([1, 2, 3]),
    profile_image_mime_type: 'image/png'
  };

  const payload = serializeUserForClient(user);

  assert.deepEqual(
    payload,
    {
      id: user.id,
      email: user.email,
      created_at: user.created_at,
      onboarding_completed_at: user.onboarding_completed_at,
      weight_unit: user.weight_unit,
      height_unit: user.height_unit,
      timezone: user.timezone,
      language: 'en',
      reminder_log_weight_enabled: user.reminder_log_weight_enabled,
      reminder_log_food_enabled: user.reminder_log_food_enabled,
      reminder_log_weight_time: '07:30',
      reminder_log_food_time: '19:15',
      reminder_quiet_hours_start: '22:00',
      reminder_quiet_hours_end: '06:00',
      haptics_enabled: user.haptics_enabled,
      date_of_birth: '1990-01-15',
      sex: user.sex,
      height_mm: user.height_mm,
      activity_level: user.activity_level,
      profile_image_url: 'data:image/png;base64,AQID',
      account_access: { state: 'full', email_verified: true, legal_current: true }
    }
  );
});
