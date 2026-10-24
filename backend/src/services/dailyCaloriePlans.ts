/** @file Durable local-day calorie plan snapshots written under the caller-owned planning transaction guard. */

import { Prisma } from '@prisma/client';
import { CALORIE_POLICY_VERSION, localDateInTimeZone } from '../../../shared/caloriePolicy';
import { parseLocalDateOnly } from '../utils/date';
import { buildStoredCaloriePlanningSnapshot, type StoredCaloriePlanningSnapshot } from './caloriePlanning';
import { lockCaloriePlanningInputs } from './caloriePlanningLock';
import type { MutationDatabase } from './clientOperations';

/** Caller holds the account planning guard through commit. Never pass a historical/preview plan. */
export async function retainDailyCaloriePlan(db: MutationDatabase, plan: StoredCaloriePlanningSnapshot, now: Date): Promise<void> {
  if (!plan.localToday || localDateInTimeZone(now, plan.user.timezone) !== plan.localToday) return;
  const where = { user_id_local_date: { user_id: plan.user.id, local_date: parseLocalDateOnly(plan.localToday) } };
  const existing = await db.dailyCaloriePlan.findUnique({ where });
  if (existing?.consumed_at || existing?.timezone_conflict) return;
  if (existing && existing.timezone !== plan.user.timezone) {
    // Keep the original provenance; one date observed in different zones is ambiguous.
    await db.dailyCaloriePlan.update({ where, data: { timezone_conflict: true } });
    return;
  }
  if (existing && existing.observed_at > now) return;
  const target = plan.evaluation.dailyCalorieTarget;
  const maintenance = plan.evaluation.tdee === null ? null : Math.round(plan.evaluation.tdee);
  const available = plan.evaluation.status === 'available' &&
    target !== null && Number.isSafeInteger(target) && target > 0 &&
    maintenance !== null && Number.isSafeInteger(maintenance) && maintenance > 0;
  const data = {
    timezone: plan.user.timezone,
    observed_at: now,
    calculation_version: CALORIE_POLICY_VERSION,
    target_kcal: available ? target : null,
    maintenance_kcal: available ? maintenance : null,
    inputs: JSON.parse(JSON.stringify({
      profile: plan.user, goal: plan.goal, weight_metric: plan.weightMetric,
      latest_weight_grams: plan.latestWeightGrams,
      effective_revision: plan.effectiveRevision, pace_revision: plan.paceRevision,
      future_revisions: plan.futureRevisions, evaluation: plan.evaluation
    })) as Prisma.InputJsonValue
  };
  await db.dailyCaloriePlan.upsert({ where, create: { ...where.user_id_local_date, ...data }, update: data });
}

/** Observe the server's current date after acquiring the guard, including unavailable transitions. */
export async function observeCurrentCaloriePlan(db: MutationDatabase, userId: number, at?: Date) {
  await lockCaloriePlanningInputs(db, userId);
  const now = at ?? new Date();
  const plan = await buildStoredCaloriePlanningSnapshot(db, userId, now);
  if (plan) await retainDailyCaloriePlan(db, plan, now);
  return plan;
}

/** Food writes observe only today's plan, never the date supplied by a late/offline client. */
export async function observeFoodActivityPlan(db: MutationDatabase, userId: number, dates: Date[]): Promise<void> {
  await lockCaloriePlanningInputs(db, userId);
  const now = new Date();
  const user = await db.user.findUnique({ where: { id: userId }, select: { timezone: true } });
  const today = user && localDateInTimeZone(now, user.timezone);
  if (!today || !dates.some(date => date.toISOString().slice(0, 10) === today)) return;
  const plan = await buildStoredCaloriePlanningSnapshot(db, userId, now);
  if (plan) await retainDailyCaloriePlan(db, plan, now);
}

/** A timezone edit cannot make an unfrozen observation belong to a different account-local day. */
export async function invalidateDailyPlanTimezone(db: MutationDatabase, userId: number, oldTimezone: string, newTimezone: string, now: Date) {
  if (oldTimezone === newTimezone) return;
  const dates = [localDateInTimeZone(now, oldTimezone), localDateInTimeZone(now, newTimezone)]
    .filter((date): date is string => date !== null).map(parseLocalDateOnly);
  await db.dailyCaloriePlan.updateMany({
    where: { user_id: userId, consumed_at: null, local_date: { in: dates } },
    data: { timezone_conflict: true }
  });
}
