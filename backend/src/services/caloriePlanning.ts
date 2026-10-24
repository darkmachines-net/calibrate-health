/** @file Transaction-consistent profile, goal, and calibration inputs for authoritative daily calorie planning. */

import { Prisma } from '@prisma/client';
import {
  evaluateCaloriePlan,
  localDateInTimeZone,
  projectGoalEndDate,
  type CaloriePlanEvaluation,
  type GoalProjection
} from '../../../shared/caloriePolicy';
import prisma from '../config/database';
import type { MutationDatabase } from './clientOperations';
import { parseLocalDateOnly } from '../utils/date';

type PlanningDatabase = MutationDatabase;

type StoredPlanningRevision = {
  id: number;
  recommendation_id: number | null;
  configured_daily_deficit: number | null;
  target_adjustment_kcal: number;
  calorie_plan_review_status: 'CLEAR' | 'REQUIRES_REVIEW';
  calorie_plan_review_reason: string | null;
  effective_local_date: Date;
};
export type StoredCaloriePlanningSnapshot = {
  user: {
    id: number;
    timezone: string;
    date_of_birth: Date | null;
    sex: 'MALE' | 'FEMALE' | null;
    height_mm: number | null;
    activity_level: 'SEDENTARY' | 'LIGHT' | 'MODERATE' | 'ACTIVE' | 'VERY_ACTIVE' | null;
    weight_unit: 'KG' | 'LB';
    height_unit: 'CM' | 'FT_IN';
  };
  goal: {
    id: number;
    user_id: number;
    start_weight_grams: number;
    target_weight_grams: number;
    daily_deficit: number;
    target_date: Date | null;
    created_at: Date;
    calorie_plan_review_status: 'CLEAR' | 'REQUIRES_REVIEW';
    calorie_plan_review_reason: string | null;
  } | null;
  latestWeightGrams: number | null;
  weightMetric: { id: number; date: Date; weight_grams: number } | null;
  paceRevision: StoredPlanningRevision | null;
  localToday: string | null;
  effectiveRevision: StoredPlanningRevision | null;
  nextRevision: StoredPlanningRevision | null;
  futureRevisions: StoredPlanningRevision[];
  unsafeRevisionIds: number[];
  evaluation: CaloriePlanEvaluation;
  projection: GoalProjection | null;
};

/** Resolve one internally consistent calorie-planning snapshot inside an existing transaction. */
export async function buildStoredCaloriePlanningSnapshot(
  database: PlanningDatabase,
  userId: number,
  now: Date = new Date()
): Promise<StoredCaloriePlanningSnapshot | null> {
  const user = await database.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      timezone: true,
      date_of_birth: true,
      sex: true,
      height_mm: true,
      activity_level: true,
      weight_unit: true,
      height_unit: true
    }
  });
  if (!user) return null;

  const localToday = localDateInTimeZone(now, user.timezone);
  const localTodayDate = localToday ? parseLocalDateOnly(localToday) : null;
  const storedGoal = await database.goal.findFirst({
    where: { user_id: userId },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      user_id: true,
      start_weight_grams: true,
      target_weight_grams: true,
      daily_deficit: true,
      target_date: true,
      created_at: true,
      calorie_plan_review_status: true,
      calorie_plan_review_reason: true
    }
  });

  const goal = storedGoal ? { ...storedGoal } : null;

  const latestMetric = localTodayDate ? await database.bodyMetric.findFirst({
    where: { user_id: userId, date: { lte: localTodayDate } },
    orderBy: [{ date: 'desc' }, { id: 'desc' }],
    select: { id: true, date: true, weight_grams: true }
  }) : null;

  const revisionSelect = {
    id: true,
    recommendation_id: true,
    configured_daily_deficit: true,
    target_adjustment_kcal: true,
    calorie_plan_review_status: true,
    calorie_plan_review_reason: true,
    effective_local_date: true
  } as const;
  const [effectiveRevision, futureRevisions] = goal && localTodayDate ? await Promise.all([
    database.caloriePlanRevision.findFirst({
      where: { user_id: userId, source_goal_id: goal.id, effective_local_date: { lte: localTodayDate } },
      orderBy: [{ effective_local_date: 'desc' }, { id: 'desc' }],
      select: revisionSelect
    }),
    database.caloriePlanRevision.findMany({
      where: { user_id: userId, source_goal_id: goal.id, effective_local_date: { gt: localTodayDate } },
      orderBy: [{ effective_local_date: 'asc' }, { id: 'asc' }],
      select: revisionSelect
    })
  ]) : [null, []];
  // Resolve pace separately so a later calibration correction cannot restore an obsolete deficit.
  const paceRevision = goal && localTodayDate ? await database.caloriePlanRevision.findFirst({
    where: { user_id: userId, source_goal_id: goal.id, configured_daily_deficit: { not: null }, effective_local_date: { lte: localTodayDate } },
    orderBy: [{ effective_local_date: 'desc' }, { id: 'desc' }],
    select: revisionSelect
  }) : null;
  if (goal && typeof paceRevision?.configured_daily_deficit === 'number') {
    goal.daily_deficit = paceRevision.configured_daily_deficit;
  }
  const nextRevision = futureRevisions[0] ?? null;

  const currentEvaluation = evaluateCaloriePlan({
    profile: {
      timezone: user.timezone,
      dateOfBirth: user.date_of_birth,
      sex: user.sex,
      heightMm: user.height_mm,
      activityLevel: user.activity_level
    },
    latestWeightGrams: latestMetric?.weight_grams ?? null,
    goal: goal ? {
      startWeightGrams: goal.start_weight_grams,
      targetWeightGrams: goal.target_weight_grams,
      dailyDeficit: goal.daily_deficit,
      reviewStatus: goal.calorie_plan_review_status,
      reviewReason: goal.calorie_plan_review_reason
    } : null,
    targetAdjustmentKcal: effectiveRevision?.target_adjustment_kcal ?? 0,
    revisionReviewStatus: effectiveRevision?.calorie_plan_review_status,
    revisionReviewReason: effectiveRevision?.calorie_plan_review_reason,
    now
  });
  const revisionTargetIsUnsafe = (revision: StoredPlanningRevision): boolean =>
    revision.calorie_plan_review_status === 'REQUIRES_REVIEW' ||
    !Number.isInteger(revision.target_adjustment_kcal) ||
    (goal !== null && currentEvaluation.tdee !== null && currentEvaluation.minimumDailyCalorieTarget !== null &&
      Math.round(currentEvaluation.tdee - goal.daily_deficit + revision.target_adjustment_kcal) < currentEvaluation.minimumDailyCalorieTarget);
  const unsafeRevisionIds = [effectiveRevision, ...futureRevisions]
    .filter((revision): revision is StoredPlanningRevision => revision !== null && revisionTargetIsUnsafe(revision))
    .map((revision) => revision.id);
  const hasUnsafeFutureRevision = futureRevisions.some((revision) => unsafeRevisionIds.includes(revision.id));
  const evaluation = hasUnsafeFutureRevision &&
    (currentEvaluation.status === 'available' || currentEvaluation.reasonCode === 'HISTORICAL_PLAN_REQUIRES_REVIEW')
      ? { ...currentEvaluation, status: 'requires_review' as const, reasonCode: 'PLAN_REVISION_UNSAFE' as const, dailyCalorieTarget: null }
      : currentEvaluation;
  const projection = goal ? projectGoalEndDate({
    planStatus: evaluation.status,
    planReasonCode: evaluation.reasonCode,
    localDate: localToday,
    currentWeightGrams: latestMetric?.weight_grams ?? null,
    targetWeightGrams: goal.target_weight_grams,
    dailyDeficit: goal.daily_deficit,
    weightUnit: user.weight_unit
  }) : null;

  return {
    user,
    goal,
    latestWeightGrams: latestMetric?.weight_grams ?? null,
    weightMetric: latestMetric,
    paceRevision,
    localToday,
    effectiveRevision,
    nextRevision,
    futureRevisions,
    unsafeRevisionIds,
    evaluation,
    projection
  };
}

/** Resolve the stored snapshot with repeatable-read semantics for dynamic API reads. */
export function getStoredCaloriePlanningSnapshot(userId: number, now: Date = new Date()): Promise<StoredCaloriePlanningSnapshot | null> {
  return prisma.$transaction(
    (tx) => buildStoredCaloriePlanningSnapshot(tx, userId, now),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
  );
}

/** Expose available planning values while omitting null calculations instead of inventing numeric targets. */
export const calorieSummaryWire = (evaluation: CaloriePlanEvaluation) => ({
  ...(evaluation.bmr === null ? {} : { bmr: evaluation.bmr }),
  ...(evaluation.tdee === null ? {} : { tdee: evaluation.tdee }),
  ...(evaluation.baseDailyCalorieTarget === null ? {} : { baseDailyCalorieTarget: evaluation.baseDailyCalorieTarget }),
  ...(evaluation.dailyCalorieTarget === null ? {} : { dailyCalorieTarget: evaluation.dailyCalorieTarget }),
  ...(evaluation.targetAdjustment === null ? {} : { targetAdjustment: evaluation.targetAdjustment }),
  ...(evaluation.sourceWeightKg === null ? {} : { sourceWeightKg: evaluation.sourceWeightKg }),
  deficit: evaluation.deficit,
  missing: evaluation.missing,
  eligibility: evaluation.eligibility,
  planStatus: evaluation.status,
  planReasonCode: evaluation.reasonCode,
  planOptions: evaluation.planOptions,
  minimumDailyCalorieTarget: evaluation.minimumDailyCalorieTarget
});

/** Translate the projection status, nullable date and reason into the API's snake-case shape. */
export const projectionWire = (projection: GoalProjection) => ({
  status: projection.status,
  projected_end_date: projection.projectedEndDate,
  reason_code: projection.reasonCode
});
