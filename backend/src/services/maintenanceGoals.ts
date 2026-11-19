/** @file Reviews and commits goal transitions and maintenance settings, including the estimated maintenance budget. */
import { createHash } from 'node:crypto';
import type { Goal } from '@prisma/client';
import { evaluateCaloriePlan, isPolicyDailyDeficit, isPolicyWeight } from '../../../shared/caloriePolicy';
import { assessMaintenanceRange, defaultMaintenanceRange, isMaintenanceRange } from '../../../shared/goalAssessment';
import { parseLocalDateOnly } from '../utils/date';
import { buildStoredCaloriePlanningSnapshot, type StoredCaloriePlanningSnapshot } from './caloriePlanning';
import { recordSyncChange, type MutationDatabase } from './clientOperations';
import { retainDailyCaloriePlan } from './dailyCaloriePlans';
import { resumeFoodTracking, serializePause, startFoodTrackingPause, updateFoodTrackingPauseExpectation } from './foodTracking';
import { maintenanceAssessment, readGoalTrend, reconcileGoalCompletion } from './goalAssessment';

type GoalChange = Record<string, unknown>;

/** Read the canonical account snapshot. The caller holds the account planning lock. */
export async function getGoalStatusSnapshot(tx: MutationDatabase, userId: number, now: Date) {
    const planning = await buildStoredCaloriePlanningSnapshot(tx, userId, now);
    if (!planning?.localToday) return null;
    const today = parseLocalDateOnly(planning.localToday);
    const [storedGoal, evidence, pause] = await Promise.all([
        planning.goal ? tx.goal.findUnique({ where: { id: planning.goal.id } }) : null,
        readGoalTrend(tx, userId, today),
        tx.foodTrackingPause.findFirst({ where: { user_id: userId, resumed_on: null } })
    ]);
    const goal = storedGoal ? await reconcileGoalCompletion(tx, storedGoal, today, planning.user.timezone, evidence) : null;
    const recovery = goal?.recovery_maintenance_goal_id ? await tx.goal.findFirst({
        where: { id: goal.recovery_maintenance_goal_id, user_id: userId, daily_deficit: 0 }
    }) : null;
    const configuredRange = goal && goal.daily_deficit === 0 ? rangeWire(goal) : null;
    const range = configuredRange ?? (goal?.daily_deficit === 0 ? defaultMaintenanceRange(goal.target_weight_grams, planning.user.weight_unit) : null);
    const previewWeight = planning.latestWeightGrams;
    const maintenanceBudget = previewWeight === null ? null : evaluateBudget(planning, previewWeight, previewWeight, 0, now).dailyCalorieTarget;
    const wire = {
        expected_version: createHash('sha256').update(JSON.stringify([
            planning.user, goal, recovery, planning.localToday, planning.effectiveRevision, planning.paceRevision, planning.futureRevisions, evidence.revision,
            pause && { id: pause.id, starts_on: pause.starts_on, expected_resume_on: pause.expected_resume_on }
        ])).digest('hex'),
        goal: goal && {
            id: goal.id, daily_deficit: planning.goal!.daily_deficit, target_weight_grams: goal.target_weight_grams,
            completed_on: goal.completed_on?.toISOString().slice(0, 10) ?? null
        },
        weight_unit: planning.user.weight_unit,
        tracking: !pause || pause.starts_on > today,
        starting_weight_grams: evidence.evidence === 'current' && evidence.trend ? evidence.trend.weight_grams : planning.latestWeightGrams,
        trend: evidence.trend,
        evidence: evidence.evidence,
        maintenance: goal?.daily_deficit === 0 && range ? {
            range, status: maintenanceAssessment(goal, evidence), offset_kcal: 0, return_to_neutral: false
        } : null,
        recovery_range: recovery ? rangeWire(recovery) : null,
        target_kcal: planning.evaluation.dailyCalorieTarget,
        budget_options: [{ offset_kcal: 0, target_kcal: maintenanceBudget }],
        pace_options: planning.evaluation.planOptions
    };
    return { planning, today, goal, pause, wire };
}

function rangeWire(goal: Goal) {
    if (goal.maintenance_lower_grams == null || goal.maintenance_upper_grams == null) return null;
    return {
        target_weight_grams: goal.target_weight_grams, lower_weight_grams: goal.maintenance_lower_grams,
        upper_weight_grams: goal.maintenance_upper_grams
    };
}

function rangeData(change: GoalChange) {
    return {
        target_weight_grams: change.target_weight_grams as number,
        maintenance_lower_grams: change.lower_weight_grams as number,
        maintenance_upper_grams: change.upper_weight_grams as number
    };
}

function evaluateBudget(planning: StoredCaloriePlanningSnapshot, start: number, target: number, deficit: number, now: Date) {
    const user = planning.user;
    return evaluateCaloriePlan({
        profile: { timezone: user.timezone, dateOfBirth: user.date_of_birth, sex: user.sex, heightMm: user.height_mm, activityLevel: user.activity_level },
        latestWeightGrams: planning.latestWeightGrams, now,
        goal: { startWeightGrams: start, targetWeightGrams: target, dailyDeficit: deficit, reviewStatus: 'CLEAR' }
    });
}

const invalid = (message: string) => ({ status: 400, body: { code: 'INVALID_GOAL_CHANGE', message } });
const changed = () => ({ status: 409, body: { code: 'GOAL_PLAN_CHANGED', message: 'Your goal or weight trend changed. Review the current settings and try again.' } });

/** Validate a reviewed change and commit its goal and tracking state as one operation. */
export async function commitGoalChange(tx: MutationDatabase, userId: number, change: GoalChange, editId: number | null, now: Date, operationId?: string) {
    const snapshot = await getGoalStatusSnapshot(tx, userId, now);
    if (!snapshot || change.expected_version !== snapshot.wire.expected_version) return changed();
    const { planning, goal, today, pause, wire } = snapshot;
    const target = change.target_weight_grams;
    if (!isPolicyWeight(target)) return invalid('Enter a target weight within the supported range.');
    if (change.tracking !== undefined && typeof change.tracking !== 'boolean') return invalid('Choose whether to track calories.');
    const tracking = typeof change.tracking === 'boolean' ? change.tracking : wire.tracking;
    if (change.offset_kcal !== undefined && change.offset_kcal !== 0) return invalid('Set a Lose or Gain goal to use a calorie deficit or surplus.');
    let result: Goal;
    if (editId !== null) {
        if (!goal || goal.id !== editId || goal.daily_deficit !== 0) return changed();
        if (!isMaintenanceRange(target, change.lower_weight_grams, change.upper_weight_grams)) return invalid('Choose a lower limit below and an upper limit above your target.');
        const settings = rangeData(change);
        const settingsChanged = goal.target_weight_grams !== target || goal.maintenance_lower_grams !== settings.maintenance_lower_grams ||
            goal.maintenance_upper_grams !== settings.maintenance_upper_grams;
        const reviewBudget = tracking && (!wire.tracking || change.offset_kcal === 0);
        if (reviewBudget && evaluateBudget(planning, goal.start_weight_grams, target, 0, now).status !== 'available') {
            return invalid('The maintenance budget is unavailable. Review your profile before turning on calorie tracking.');
        }
        result = goal;
        if (settingsChanged) {
            await tx.maintenanceGoalRevision.create({ data: {
                goal_id: goal.id, target_weight_grams: goal.target_weight_grams,
                lower_weight_grams: goal.maintenance_lower_grams, upper_weight_grams: goal.maintenance_upper_grams, effective_local_date: today
            } });
            result = await tx.goal.update({ where: { id: goal.id }, data: settings });
        }
        if (reviewBudget && goal.calorie_plan_review_status !== 'CLEAR') {
            result = await tx.goal.update({ where: { id: goal.id }, data: {
                calorie_plan_review_status: 'CLEAR', calorie_plan_review_reason: null
            } });
        }
    } else {
        const deficit = change.daily_deficit;
        const start = wire.starting_weight_grams;
        if (!isPolicyDailyDeficit(deficit) || !isPolicyWeight(start) || typeof change.tracking !== 'boolean') {
            return invalid('Log a current weight and choose an available goal and tracking mode.');
        }
        if (deficit === 0) {
            const lower = change.lower_weight_grams;
            const upper = change.upper_weight_grams;
            if (!isPolicyWeight(lower) || !isPolicyWeight(upper) || !isMaintenanceRange(target, lower, upper)) {
                return invalid('Choose a lower limit below and an upper limit above your target.');
            }
            if (assessMaintenanceRange(start, { target_weight_grams: target, lower_weight_grams: lower, upper_weight_grams: upper }) !== 'within_range') {
                return invalid('Adjust the target or range to include your current weight.');
            }
        }
        if ((deficit > 0 && target >= start) || (deficit < 0 && target <= start)) return invalid('Choose a target that matches the direction of your new goal.');
        if ((deficit !== 0 || tracking) && evaluateBudget(planning, start, target, deficit, now).status !== 'available') {
            return invalid(deficit === 0 ? 'The maintenance budget is unavailable. Review your profile before turning on calorie tracking.' :
                'That calorie budget is unavailable. Review your profile or choose another pace.');
        }
        const status = wire.maintenance?.status;
        const recovery = change.return_to_target === true;
        if (recovery && (!goal || target !== goal.target_weight_grams ||
            !((status === 'above_range' && deficit > 0) || (status === 'below_range' && deficit < 0)))) return changed();
        result = await tx.goal.create({ data: {
            user_id: userId, start_weight_grams: start, target_weight_grams: target, daily_deficit: deficit, created_at: now,
            ...(deficit === 0 ? rangeData(change) : {}),
            predecessor_goal_id: goal?.id, recovery_maintenance_goal_id: recovery ? goal?.id : null,
            start_from_trend: wire.evidence === 'current'
        } });
        if (goal) {
            await tx.calibrationRecommendation.updateMany({
                where: { user_id: userId, source_goal_id: goal.id, status: 'PENDING' }, data: { status: 'STALE' }
            });
        }
    }
    // Use the same pause records as Today and Wear.
    if (typeof change.tracking === 'boolean' && (editId === null || tracking !== wire.tracking)) {
        const futurePause = pause && pause.starts_on > today;
        if (futurePause) {
            const canceled = await tx.foodTrackingPause.update({ where: { id: pause.id }, data: { resumed_on: pause.starts_on, resumed_at: now } });
            await recordSyncChange({ tx, userId, entityType: 'food_tracking_pause', entityId: canceled.id,
                action: 'upsert', operationId, payload: serializePause(canceled, today) });
        }
        if (tracking && pause && !futurePause) await resumeFoodTracking({ tx, userId, resumedOn: today, now, operationId });
        if (!tracking && (!pause || futurePause)) await startFoodTrackingPause({ tx, userId, startsOn: today, expectedResumeOn: null, now, operationId });
        if (!tracking && pause && !futurePause && editId === null && pause.expected_resume_on) {
            await updateFoodTrackingPauseExpectation({ tx, userId, expectedResumeOn: null, today, operationId });
        }
    }
    const updated = await buildStoredCaloriePlanningSnapshot(tx, userId, now);
    if (updated) await retainDailyCaloriePlan(tx, updated, now);
    await recordSyncChange({ tx, userId, entityType: 'goal', entityId: result.id, action: 'upsert', operationId, payload: result });
    return { status: 200, body: { goal_id: result.id } };
}
