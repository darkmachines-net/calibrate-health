/** @file Validated profile and initial-goal setup committed atomically under account planning guards. */

import { observeCurrentCaloriePlan } from './dailyCaloriePlans';
import type {
  ActivityLevel,
  HeightUnit,
  Prisma,
  Sex,
  WeightUnit
} from '@prisma/client';
import {
  evaluateCaloriePlan,
  isPolicyDailyDeficit,
  isPolicyHeight,
  isPolicyWeight,
  normalizeDateOfBirth
} from '../../../shared/caloriePolicy';
import { getUtcTodayDateOnlyInTimeZone, isValidIanaTimeZone } from '../utils/date';
import { isActivityLevel, isSex } from '../utils/profile';
import { isHeightUnit, isWeightUnit } from '../utils/units';
import {
  serializeUserForClient,
  USER_CLIENT_SELECT,
  type UserClientPayload
} from '../utils/userSerialization';
import type { MutationDatabase, MutationResult } from './clientOperations';

const MIN_ACCOUNT_AGE_YEARS = 18;

type CompleteOnboardingData = {
  weight_unit: WeightUnit;
  height_unit: HeightUnit;
  timezone: string;
  date_of_birth: string;
  sex: Sex;
  height_mm: number;
  activity_level: ActivityLevel;
  current_weight_grams: number;
  target_weight_grams: number;
  daily_deficit: number;
};

export type CompleteOnboardingInput = {
  data: CompleteOnboardingData;
};

type OnboardingCompletionReceipt = {
  operation_id: string;
  completed_at: string;
  goal_id: number;
  metric_id: number;
  sync_cursor: string;
};

export type OnboardingCompletionResponse = {
  receipt: OnboardingCompletionReceipt;
  user: UserClientPayload;
};

export type OnboardingWriteStage =
  | 'profile'
  | 'metric'
  | 'goal'
  | 'sync_marker'
  | 'completion';

type OnboardingParseFailure = {
  ok: false;
  code: 'INVALID_ONBOARDING';
  message: string;
  fieldErrors?: Record<string, string[]>;
};

export type OnboardingParseResult<T> = { ok: true; value: T } | OnboardingParseFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalidField(field: string, message: string): OnboardingParseFailure {
  return {
    ok: false,
    code: 'INVALID_ONBOARDING',
    message: 'Invalid onboarding details.',
    fieldErrors: { [field]: [message] }
  };
}

function parseCompleteData(value: unknown): OnboardingParseResult<CompleteOnboardingData> {
  if (!isRecord(value)) return invalidField('data', 'Onboarding details are required.');

  const requiredFields: Array<keyof CompleteOnboardingData> = [
    'weight_unit',
    'height_unit',
    'timezone',
    'date_of_birth',
    'sex',
    'height_mm',
    'activity_level',
    'current_weight_grams',
    'target_weight_grams',
    'daily_deficit'
  ];
  for (const field of requiredFields) {
    if (value[field] === undefined) return invalidField(field, 'This field is required.');
  }

  if (!isWeightUnit(value.weight_unit)) {
    return invalidField('weight_unit', 'Choose a supported weight unit.');
  }
  if (!isHeightUnit(value.height_unit)) {
    return invalidField('height_unit', 'Choose a supported height unit.');
  }
  if (typeof value.timezone !== 'string' || !isValidIanaTimeZone(value.timezone)) {
    return invalidField('timezone', 'Choose a valid IANA timezone.');
  }
  const dateOfBirth = normalizeDateOfBirth(value.date_of_birth);
  if (!dateOfBirth || dateOfBirth !== value.date_of_birth) {
    return invalidField('date_of_birth', 'Use a valid date in YYYY-MM-DD format.');
  }
  if (!isSex(value.sex)) return invalidField('sex', 'Choose a supported sex value.');
  if (!isPolicyHeight(value.height_mm)) {
    return invalidField('height_mm', 'Enter a height within the supported range.');
  }
  if (!isActivityLevel(value.activity_level)) {
    return invalidField('activity_level', 'Choose a supported activity level.');
  }
  if (!isPolicyWeight(value.current_weight_grams)) {
    return invalidField('current_weight_grams', 'Enter a weight within the supported range.');
  }
  if (!isPolicyWeight(value.target_weight_grams)) {
    return invalidField('target_weight_grams', 'Enter a weight within the supported range.');
  }
  if (!isPolicyDailyDeficit(value.daily_deficit)) {
    return invalidField('daily_deficit', 'Choose an available calorie plan option.');
  }
  if (
    (value.daily_deficit > 0 && value.current_weight_grams <= value.target_weight_grams) ||
    (value.daily_deficit < 0 && value.current_weight_grams >= value.target_weight_grams)
  ) {
    return invalidField('target_weight_grams', 'The target weight does not match the selected plan direction.');
  }

  const data: CompleteOnboardingData = {
    weight_unit: value.weight_unit,
    height_unit: value.height_unit,
    timezone: value.timezone.trim(),
    date_of_birth: dateOfBirth,
    sex: value.sex,
    height_mm: value.height_mm,
    activity_level: value.activity_level,
    current_weight_grams: value.current_weight_grams,
    target_weight_grams: value.target_weight_grams,
    daily_deficit: value.daily_deficit
  };
  const evaluation = evaluateCaloriePlan({
    profile: {
      timezone: data.timezone,
      dateOfBirth: data.date_of_birth,
      sex: data.sex,
      heightMm: data.height_mm,
      activityLevel: data.activity_level
    },
    latestWeightGrams: data.current_weight_grams,
    goal: {
      startWeightGrams: data.current_weight_grams,
      targetWeightGrams: data.target_weight_grams,
      dailyDeficit: data.daily_deficit,
      reviewStatus: 'CLEAR'
    }
  });
  if (
    evaluation.eligibility.status !== 'eligible' ||
    evaluation.eligibility.ageYears === null ||
    evaluation.eligibility.ageYears < MIN_ACCOUNT_AGE_YEARS
  ) {
    return invalidField('date_of_birth', 'Calibrate accounts require age 18 or older.');
  }
  if (evaluation.status !== 'available') {
    return invalidField('daily_deficit', 'Choose an available calorie plan option.');
  }

  return { ok: true, value: data };
}

/** Validate the complete profile/goal payload and return structured field errors without partial writes. */
export function parseCompleteOnboardingBody(
  body: unknown
): OnboardingParseResult<CompleteOnboardingInput> {
  if (!isRecord(body)) return invalidField('body', 'Onboarding details are required.');
  const parsedData = parseCompleteData(body.data);
  return parsedData.ok ? { ok: true, value: { data: parsedData.value } } : parsedData;
}

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function lockUser(tx: MutationDatabase, userId: number): Promise<void> {
  await tx.$queryRawUnsafe(
    'SELECT "id" FROM "User" WHERE "id" = $1 FOR UPDATE',
    userId
  );
}

async function existingCompletionResponse(
  tx: MutationDatabase,
  userId: number
): Promise<OnboardingCompletionResponse | null> {
  const operation = await tx.clientOperation.findFirst({
    where: {
      user_id: userId,
      operation_kind: 'onboarding.complete',
      response_status: 200,
      completed_at: { not: null }
    },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    select: { response_body: true }
  });
  return isRecord(operation?.response_body)
    ? operation.response_body as unknown as OnboardingCompletionResponse
    : null;
}

/** Lock the account and commit profile, goal and completion together, preserving idempotent completed responses. */
export async function completeOnboardingInTransaction(
  tx: MutationDatabase,
  userId: number,
  operationId: string,
  input: CompleteOnboardingInput,
  options: {
    now?: Date;
    afterWrite?: (stage: OnboardingWriteStage) => void | Promise<void>;
  } = {}
): Promise<MutationResult<OnboardingCompletionResponse | Record<string, unknown>>> {
  await lockUser(tx, userId);
  const current = await tx.user.findUnique({
    where: { id: userId },
    select: { onboarding_completed_at: true }
  });
  if (!current) return { status: 404, body: { message: 'User not found' } };

  if (current.onboarding_completed_at) {
    const existing = await existingCompletionResponse(tx, userId);
    if (existing) return { status: 200, body: existing };
    return {
      status: 409,
      body: {
        message: 'Onboarding is already complete.',
        code: 'ONBOARDING_ALREADY_COMPLETED',
        retryable: false
      }
    };
  }

  const now = options.now ?? new Date();
  const metricDate = getUtcTodayDateOnlyInTimeZone(input.data.timezone, now);
  const dateOfBirth = new Date(input.data.date_of_birth + 'T00:00:00.000Z');

  await tx.user.update({
    where: { id: userId },
    data: {
      weight_unit: input.data.weight_unit,
      height_unit: input.data.height_unit,
      timezone: input.data.timezone,
      date_of_birth: dateOfBirth,
      sex: input.data.sex,
      height_mm: input.data.height_mm,
      activity_level: input.data.activity_level
    }
  });
  await options.afterWrite?.('profile');

  const metric = await tx.bodyMetric.upsert({
    where: { user_id_date: { user_id: userId, date: metricDate } },
    update: { weight_grams: input.data.current_weight_grams },
    create: {
      user_id: userId,
      date: metricDate,
      weight_grams: input.data.current_weight_grams
    }
  });
  await options.afterWrite?.('metric');

  const existingGoal = await tx.goal.findFirst({
    where: { user_id: userId },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    select: { id: true }
  });
  const goalData = {
    start_weight_grams: input.data.current_weight_grams,
    target_weight_grams: input.data.target_weight_grams,
    target_date: null,
    daily_deficit: input.data.daily_deficit,
    calorie_plan_review_status: 'CLEAR' as const,
    calorie_plan_review_reason: null
  };
  const goal = existingGoal
    ? await tx.goal.update({ where: { id: existingGoal.id }, data: goalData })
    : await tx.goal.create({ data: { user_id: userId, ...goalData } });
  await options.afterWrite?.('goal');

  const completedAt = now.toISOString();
  const syncMarker = await tx.syncChange.create({
    data: {
      user_id: userId,
      entity_type: 'onboarding_completion',
      entity_id: String(userId),
      action: 'upsert',
      operation_id: operationId,
      payload: toInputJson({ completed_at: completedAt })
    }
  });
  await options.afterWrite?.('sync_marker');

  const completedUser = await tx.user.update({
    where: { id: userId },
    data: { onboarding_completed_at: now },
    select: USER_CLIENT_SELECT
  });
  await options.afterWrite?.('completion');
  await observeCurrentCaloriePlan(tx, userId, now);

  return {
    status: 200,
    body: {
      receipt: {
        operation_id: operationId,
        completed_at: completedAt,
        goal_id: goal.id,
        metric_id: metric.id,
        sync_cursor: syncMarker.id.toString()
      },
      user: serializeUserForClient(completedUser)
    }
  };
}
