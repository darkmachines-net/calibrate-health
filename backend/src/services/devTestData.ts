/** @file Deterministic local test-account histories and scenario seeding for development and browser validation. */

import fs from 'node:fs/promises';
import path from 'node:path';
import prisma from '../config/database';
import { SUPPORTED_LANGUAGES } from '../utils/language';
import {
  ActivityLevel,
  HeightUnit,
  Sex,
  WeightUnit
} from '@prisma/client';
import {
  buildCompletedFoodLogDays,
  buildMealLogsForDay,
  DEV_SEED_FOOD_HISTORY_DAYS,
  getPastDateRangeDates,
  getSeedUserCreatedAt,
  getSeedWeightGramsForDayIndex
} from './devTestDataUtils';
import { refreshMaterializedWeightTrendsBestEffort } from './materializedWeightTrend';
import { CURRENT_PRIVACY_VERSION, CURRENT_TERMS_VERSION } from '../../../shared/legalVersions';

/**
 * Deterministic dev seed data helpers (test user, goals, metrics, food logs).
 */
const TEST_USER_EMAIL = 'test@calibratehealth.app';
// Precomputed bcrypt hash for the deterministic dev password, "password123".
const TEST_USER_PASSWORD_HASH = '$2b$10$24sOV1l/uVCwMwPmB4.2X.K6q10fTODGqeX7xEILbzcoM0zIgAwFC';
const TEST_USER_TIMEZONE = 'America/Los_Angeles';

const TEST_USER_DATE_OF_BIRTH = new Date('1990-01-15T00:00:00');
const TEST_USER_HEIGHT_MM = 1750;
const TEST_USER_WEIGHT_GRAMS = 82000;
const TEST_GOAL_TARGET_WEIGHT_GRAMS = 76000;
const TEST_METRIC_HISTORY_DAYS = 120; // Seed roughly four months of weigh-ins so trend charts show noise vs signal.

const PROFILE_PLACEHOLDER_IMAGE_PATH = path.resolve(__dirname, '../../prisma/assets/profile-placeholder.png');
const PROFILE_PLACEHOLDER_IMAGE_MIME_TYPE = 'image/png';

type SeedProfileImage = {
  mimeType: string;
  bytes: Uint8Array<ArrayBuffer>;
};

type SeedDevTestDataOptions = {
  logTimings?: boolean;
};

let cachedProfilePlaceholderImage: SeedProfileImage | null | undefined;

/**
 * Load (and memoize) the placeholder avatar used for deterministic dev accounts.
 */
const loadProfilePlaceholderImage = async (): Promise<SeedProfileImage | null> => {
  if (cachedProfilePlaceholderImage !== undefined) {
    return cachedProfilePlaceholderImage;
  }

  try {
    const buffer = await fs.readFile(PROFILE_PLACEHOLDER_IMAGE_PATH);
    // Prisma `Bytes` columns are typed as Uint8Array; normalize eagerly for type safety.
    const bytes = new Uint8Array(buffer.length);
    bytes.set(buffer);
    cachedProfilePlaceholderImage = { bytes, mimeType: PROFILE_PLACEHOLDER_IMAGE_MIME_TYPE };
  } catch (error) {
    cachedProfilePlaceholderImage = null;
    console.warn('Dev seed: unable to load profile placeholder image:', error);
  }

  return cachedProfilePlaceholderImage;
};

/**
 * Optionally time seed phases when the standalone Prisma seed command is running.
 */
async function timedSeedPhase<T>(
  options: SeedDevTestDataOptions,
  label: string,
  task: () => Promise<T>
): Promise<T> {
  if (!options.logTimings) {
    return task();
  }

  const startedAt = Date.now();
  try {
    return await task();
  } finally {
    const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`[seed] ${label} finished in ${elapsedSeconds}s`);
  }
}

/**
 * Ensure a deterministic test user exists (and always has the expected password).
 */
const ensureTestUser = async (createdAt: Date): Promise<{ id: number }> => {
  const placeholderImage = await loadProfilePlaceholderImage();
  const placeholderImageData = placeholderImage
    ? { profile_image: placeholderImage.bytes, profile_image_mime_type: placeholderImage.mimeType }
    : {};

  const user = await prisma.user.upsert({
    where: { email: TEST_USER_EMAIL },
    create: {
      email: TEST_USER_EMAIL,
      password_hash: TEST_USER_PASSWORD_HASH,
      created_at: createdAt,
      email_verified_at: createdAt,
      timezone: TEST_USER_TIMEZONE,
      language: SUPPORTED_LANGUAGES.EN,
      weight_unit: WeightUnit.KG,
      height_unit: HeightUnit.CM,
      date_of_birth: TEST_USER_DATE_OF_BIRTH,
      sex: Sex.MALE,
      height_mm: TEST_USER_HEIGHT_MM,
      activity_level: ActivityLevel.MODERATE,
      ...placeholderImageData,
    },
    update: {
      // Keep the dev user deterministic so "invalid credentials" doesn't happen
      // if the account already existed with a different password.
      password_hash: TEST_USER_PASSWORD_HASH,
      created_at: createdAt,
      email_verified_at: createdAt,
      timezone: TEST_USER_TIMEZONE,
      language: SUPPORTED_LANGUAGES.EN,
      weight_unit: WeightUnit.KG,
      height_unit: HeightUnit.CM,
      date_of_birth: TEST_USER_DATE_OF_BIRTH,
      sex: Sex.MALE,
      height_mm: TEST_USER_HEIGHT_MM,
      activity_level: ActivityLevel.MODERATE,
      ...placeholderImageData,
    },
    select: { id: true },
  });

  await prisma.legalAcceptance.upsert({
    where: {
      user_id_terms_version_privacy_version: {
        user_id: user.id,
        terms_version: CURRENT_TERMS_VERSION,
        privacy_version: CURRENT_PRIVACY_VERSION
      }
    },
    create: {
      user_id: user.id,
      terms_version: CURRENT_TERMS_VERSION,
      privacy_version: CURRENT_PRIVACY_VERSION,
      accepted_at: createdAt
    },
    update: { accepted_at: createdAt }
  });
  return user;
};

/** Create the test user's deterministic calorie-deficit goal. */
const createTestGoal = async (userId: number, createdAt: Date): Promise<void> => {
  await prisma.goal.create({
    data: {
      user_id: userId,
      start_weight_grams: TEST_USER_WEIGHT_GRAMS,
      target_weight_grams: TEST_GOAL_TARGET_WEIGHT_GRAMS,
      daily_deficit: 500,
      created_at: createdAt,
    },
  });
};

/**
 * Restore the dedicated dev account to one predictable product-test baseline.
 *
 * This runs once per backend process. Changes made while testing remain available until the
 * next restart, when stale plan revisions and partial tracking edits are intentionally removed.
 */
const resetDevTestAccountHistory = async (userId: number): Promise<void> => {
  await prisma.$transaction(async (tx) => {
    await tx.caloriePlanRevision.deleteMany({ where: { user_id: userId } });
    await tx.calibrationRecommendation.deleteMany({ where: { user_id: userId } });
    await tx.goal.deleteMany({ where: { user_id: userId } });
    await tx.foodLog.deleteMany({ where: { user_id: userId } });
    await tx.foodLogDay.deleteMany({ where: { user_id: userId } });
    await tx.foodTrackingPause.deleteMany({ where: { user_id: userId } });
    await tx.bodyMetric.deleteMany({ where: { user_id: userId } });
    await tx.user.update({
      where: { id: userId },
      data: { onboarding_completed_at: null }
    });
  });
};

/**
 * Create daily body metrics for the configured multi-month history.
 */
const createBodyMetrics = async (userId: number, days: Date[]): Promise<void> => {
  await prisma.bodyMetric.createMany({
    data: days.map((day, index) => ({
      user_id: userId,
      date: day,
      weight_grams: getSeedWeightGramsForDayIndex(index, TEST_USER_WEIGHT_GRAMS),
    }))
  });
};

/** Mark the seeded baseline complete only after its required goal and metric writes exist. */
const markTestUserOnboardingComplete = async (userId: number, completedAt: Date): Promise<void> => {
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { onboarding_completed_at: completedAt }
    });
  });
};

/** Create deterministic daily food logs for the calibration window. */
const createFoodLogs = async (userId: number, days: Date[]): Promise<void> => {
  await prisma.foodLog.createMany({
    data: days.flatMap((day, dayIndex) => buildMealLogsForDay(userId, day, dayIndex))
  });
};

/** Mark all seeded food history as representative for immediate calibration. */
const createCompletedFoodLogDays = async (userId: number, days: Date[]): Promise<void> => {
  await prisma.foodLogDay.createMany({
    data: buildCompletedFoodLogDays(userId, days, new Date())
  });
};

/**
 * Seed the local database with a deterministic test user and sample tracking history.
 */
export const seedDevTestData = async (options: SeedDevTestDataOptions = {}): Promise<void> => {
  const startedAt = Date.now();
  const metricDays = getPastDateRangeDates(TEST_USER_TIMEZONE, TEST_METRIC_HISTORY_DAYS);
  const foodLogDays = getPastDateRangeDates(TEST_USER_TIMEZONE, DEV_SEED_FOOD_HISTORY_DAYS);
  const createdAt = getSeedUserCreatedAt(metricDays, TEST_USER_TIMEZONE);
  const goalCreatedAt = getSeedUserCreatedAt(foodLogDays, TEST_USER_TIMEZONE);

  const user = await timedSeedPhase(options, 'user', () => ensureTestUser(createdAt));

  await timedSeedPhase(options, 'baseline reset', () => resetDevTestAccountHistory(user.id));
  await timedSeedPhase(options, 'goal', () => createTestGoal(user.id, goalCreatedAt));
  await timedSeedPhase(options, 'body metrics', () => createBodyMetrics(user.id, metricDays));
  await timedSeedPhase(options, 'onboarding completion', () =>
    markTestUserOnboardingComplete(user.id, goalCreatedAt)
  );
  await timedSeedPhase(options, 'weight trends', () => refreshMaterializedWeightTrendsBestEffort(user.id));
  await timedSeedPhase(options, 'food logs', () => createFoodLogs(user.id, foodLogDays));
  await timedSeedPhase(options, 'completed food days', () => createCompletedFoodLogDays(user.id, foodLogDays));

  if (options.logTimings) {
    const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`[seed] DONE: Dev seed data is ready in ${elapsedSeconds}s.`);
  }
};

/**
 * Reset the deterministic dev test account back to a pre-onboarding state.
 *
 * This keeps the email/password stable for auto-login, but clears the fields that the frontend
 * uses to decide whether onboarding is required.
 */
export const resetDevTestUserToPreOnboardingState = async (): Promise<number> => {
  const existing = await prisma.user.findUnique({
    where: { email: TEST_USER_EMAIL },
    select: { id: true },
  });
  const user =
    existing ??
    (await ensureTestUser(getSeedUserCreatedAt(getPastDateRangeDates(TEST_USER_TIMEZONE, TEST_METRIC_HISTORY_DAYS), TEST_USER_TIMEZONE)));

  await prisma.$transaction(async (tx) => {
    await tx.goal.deleteMany({ where: { user_id: user.id } });
    await tx.bodyMetric.deleteMany({ where: { user_id: user.id } });
    await tx.foodLog.deleteMany({ where: { user_id: user.id } });
    await tx.foodLogDay.deleteMany({ where: { user_id: user.id } });

    await tx.user.update({
      where: { id: user.id },
      data: {
        date_of_birth: null,
        sex: null,
        height_mm: null,
        activity_level: null,
        profile_image: null,
        profile_image_mime_type: null,
        onboarding_completed_at: null,
      },
      select: { id: true },
    });
  });

  return user.id;
};

let seedOncePromise: Promise<void> | null = null;

/**
 * Ensure dev test data exists; safe to call multiple times (memoized per process).
 */
export const ensureDevTestData = async (): Promise<void> => {
  if (!seedOncePromise) {
    seedOncePromise = seedDevTestData().catch((error) => {
      seedOncePromise = null;
      throw error;
    });
  }

  await seedOncePromise;
};
