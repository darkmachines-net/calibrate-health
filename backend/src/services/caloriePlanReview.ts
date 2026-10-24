/** @file Persistent review state for stored calorie plans that become unsafe after relevant input changes. */

import { lockCaloriePlanningInputs } from './caloriePlanningLock';
import type { MutationDatabase } from './clientOperations';
import { buildStoredCaloriePlanningSnapshot, type StoredCaloriePlanningSnapshot } from './caloriePlanning';
import { retainDailyCaloriePlan } from './dailyCaloriePlans';

/** Persist sticky review state when the current stored plan becomes unsafe after an in-scope write. */
export async function markCurrentCaloriePlanForReviewIfUnsafe(
  database: MutationDatabase,
  userId: number,
  at?: Date
): Promise<StoredCaloriePlanningSnapshot | null> {
  // Weight/profile writers hold this guard through commit; pace saves use the same
  // guard before reading, so safety checks cannot miss a concurrent accepted pace.
  await lockCaloriePlanningInputs(database, userId);
  const now = at ?? new Date();
  const snapshot = await buildStoredCaloriePlanningSnapshot(database, userId, now);
  if (!snapshot) return null;
  if (!snapshot.goal || snapshot.evaluation.status !== 'requires_review') {
    await retainDailyCaloriePlan(database, snapshot, now);
    return snapshot;
  }

  const reviewReason = snapshot.evaluation.reasonCode ?? 'HISTORICAL_PLAN_REQUIRES_REVIEW';
  if (snapshot.goal.calorie_plan_review_status !== 'REQUIRES_REVIEW' || snapshot.goal.calorie_plan_review_reason !== reviewReason) {
    await database.goal.update({
      where: { id: snapshot.goal.id },
      data: { calorie_plan_review_status: 'REQUIRES_REVIEW', calorie_plan_review_reason: reviewReason }
    });
  }
  const revisionWhere = reviewReason === 'PLAN_REVISION_UNSAFE'
    ? { id: { in: snapshot.unsafeRevisionIds }, calorie_plan_review_status: 'CLEAR' as const }
    : { source_goal_id: snapshot.goal.id, calorie_plan_review_status: 'CLEAR' as const };
  if (reviewReason !== 'PLAN_REVISION_UNSAFE' || snapshot.unsafeRevisionIds.length > 0) {
    await database.caloriePlanRevision.updateMany({
      where: revisionWhere,
      data: { calorie_plan_review_status: 'REQUIRES_REVIEW', calorie_plan_review_reason: 'PLAN_REVISION_UNSAFE' }
    });
  }
  await database.calibrationRecommendation.updateMany({
    where: { source_goal_id: snapshot.goal.id, status: 'PENDING' },
    data: { status: 'STALE' }
  });
  const reviewed = await buildStoredCaloriePlanningSnapshot(database, userId, now);
  if (reviewed) await retainDailyCaloriePlan(database, reviewed, now);
  return reviewed;
}
