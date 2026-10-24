/** @file Goal pace validation and updates with current planning availability and canonical weight conversion. */

import crypto from 'node:crypto';
import { evaluateCaloriePlan } from '../../../shared/caloriePolicy';
import type { StoredCaloriePlanningSnapshot } from './caloriePlanning';
import { projectionWire } from './caloriePlanning';
import { gramsToWeight } from '../utils/units';
/** Convert canonical goal weights to the user's unit and include current planning/projection availability. */
export function goalWire(snapshot: StoredCaloriePlanningSnapshot) {
    if (!snapshot.goal)
        return null;
    const { start_weight_grams, target_weight_grams, ...goal } = snapshot.goal;
    return {
        ...goal,
        start_weight: gramsToWeight(start_weight_grams, snapshot.user.weight_unit),
        target_weight: gramsToWeight(target_weight_grams, snapshot.user.weight_unit),
        plan_status: snapshot.evaluation.status,
        plan_reason_code: snapshot.evaluation.reasonCode,
        projection: projectionWire(snapshot.projection!)
    };
}
/** Bind the editor to authoritative inputs, including tomorrow's accepted corrections. */
export function goalPaceVersion(snapshot: StoredCaloriePlanningSnapshot): string {
    return crypto.createHash('sha256').update(JSON.stringify({
        user: snapshot.user, goal: snapshot.goal, weight: snapshot.latestWeightGrams,
        day: snapshot.localToday, current: snapshot.effectiveRevision, future: snapshot.futureRevisions
    })).digest('hex');
}
/** Evaluate each supported deficit against the same stored planning inputs and safety policy. */
export function goalPaceOptions(snapshot: StoredCaloriePlanningSnapshot, now: Date = new Date()) {
    const { user, goal, evaluation } = snapshot;
    const planOptions = evaluation.planOptions.map(option => {
        const candidate = evaluateCaloriePlan({
            profile: { timezone: user.timezone, dateOfBirth: user.date_of_birth, sex: user.sex,
                heightMm: user.height_mm, activityLevel: user.activity_level },
            latestWeightGrams: snapshot.latestWeightGrams,
            goal: goal ? { startWeightGrams: goal.start_weight_grams, targetWeightGrams: goal.target_weight_grams,
                dailyDeficit: option.dailyDeficit, reviewStatus: goal.calorie_plan_review_status,
                reviewReason: goal.calorie_plan_review_reason } : null,
            targetAdjustmentKcal: snapshot.effectiveRevision?.target_adjustment_kcal ?? 0,
            now
        });
        const futureSafe = snapshot.futureRevisions.every(revision => revision.calorie_plan_review_status === 'CLEAR' && Number.isInteger(revision.target_adjustment_kcal) &&
            candidate.tdee !== null && candidate.minimumDailyCalorieTarget !== null &&
            Math.round(candidate.tdee - option.dailyDeficit + revision.target_adjustment_kcal) >= candidate.minimumDailyCalorieTarget);
        const available = evaluation.status === 'available' && candidate.status === 'available' && futureSafe &&
            goal !== null && Math.sign(option.dailyDeficit) === Math.sign(goal.daily_deficit);
        return { dailyDeficit: option.dailyDeficit, available,
            dailyCalorieTarget: available ? candidate.dailyCalorieTarget : null,
            reasonCode: available ? null : (evaluation.reasonCode ?? candidate.reasonCode ?? 'PLAN_REVISION_UNSAFE') };
    });
    return { goal: goalWire(snapshot), expected_plan_version: goalPaceVersion(snapshot),
        effective_local_date: snapshot.localToday,
        eligibility: evaluation.eligibility, bmr: evaluation.bmr, tdee: evaluation.tdee,
        minimumDailyCalorieTarget: evaluation.minimumDailyCalorieTarget, planOptions };
}
