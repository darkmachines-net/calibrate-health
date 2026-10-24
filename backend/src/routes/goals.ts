/** @file Account-owned goal creation, current-goal lookup, and policy-checked pace changes. */

import { lockCaloriePlanningInputs } from '../services/caloriePlanningLock';
import { observeCurrentCaloriePlan, retainDailyCaloriePlan } from '../services/dailyCaloriePlans';
import express from 'express';
import { Prisma } from '@prisma/client';
import { goalWire, goalPaceOptions, goalPaceVersion } from '../services/goalPace';
import { parseLocalDateOnly } from '../utils/date';
import { parseDailyDeficit } from '../utils/goalDeficit';
import { gramsToWeight, parseWeightToGrams, type WeightUnit } from '../utils/units';
import { validateGoalWeightsForDailyDeficit } from '../utils/goalValidation';
import {
    ClientOperationConflictError,
    executeIdempotentMutation,
    parseClientOperationId,
    recordSyncChange
} from '../services/clientOperations';
import { getAuthenticatedUser, requireAuthenticatedUser } from '../middleware/authenticatedUser';
import { evaluateCaloriePlan, isPolicyWeight, projectGoalEndDate } from '../../../shared/caloriePolicy';
import { buildStoredCaloriePlanningSnapshot, getStoredCaloriePlanningSnapshot, projectionWire } from '../services/caloriePlanning';

/**
 * Goal endpoints for creating and fetching the current goal.
 *
 * We store weights in grams and always return the latest goal, converted to the user's unit preference.
 */
const router = express.Router();

router.use(requireAuthenticatedUser);

router.get('/', async (req, res) => {
    const user = getAuthenticatedUser(req);
    try {
        const snapshot = await getStoredCaloriePlanningSnapshot(user.id);
        if (!snapshot) return res.status(404).json({ message: 'User not found' });
        if (!snapshot.goal) return res.json(null);
        return res.json(goalWire(snapshot));
    } catch {
        return res.status(500).json({ message: 'Server error' });
    }
});
router.post('/', async (req, res) => {
    const user = getAuthenticatedUser(req);
    const { start_weight, target_weight, target_date, daily_deficit } = req.body;
    const weightUnit: WeightUnit = user.weight_unit ?? 'KG';
    try {
        const operationId = parseClientOperationId(
            req.get?.('x-client-operation-id') ?? req.headers?.['x-client-operation-id']
        );
        if (operationId === null) {
            return res.status(400).json({ message: 'Invalid x-client-operation-id' });
        }

        // Validate allowed deficit choices to keep projections and targets consistent with the UI.
        const parsedDailyDeficit = parseDailyDeficit(daily_deficit);
        if (parsedDailyDeficit === null) {
            return res.status(400).json({ message: 'That calorie plan option is unavailable.', code: 'CALORIE_PLAN_OPTION_UNAVAILABLE', retryable: false, field_errors: { daily_deficit: ['Choose an available calorie plan option.'] } });
        }

        let start_weight_grams: number;
        let target_weight_grams: number;
        try {
            start_weight_grams = parseWeightToGrams(start_weight, weightUnit);
            target_weight_grams = parseWeightToGrams(target_weight, weightUnit);
        } catch {
            return res.status(400).json({ message: 'Start and target weights are invalid.', code: 'WEIGHT_OUT_OF_RANGE', retryable: false, field_errors: { start_weight: ['Enter a weight within the supported range.'], target_weight: ['Enter a weight within the supported range.'] } });
        }
        if (!isPolicyWeight(start_weight_grams) || !isPolicyWeight(target_weight_grams)) {
            return res.status(400).json({ message: 'Start and target weights must be within the supported range.', code: 'WEIGHT_OUT_OF_RANGE', retryable: false, field_errors: { start_weight: ['Enter a weight within the supported range.'], target_weight: ['Enter a weight within the supported range.'] } });
        }

        // Ensure the weight direction matches the deficit sign (loss vs gain vs maintain).
        const coherenceError = validateGoalWeightsForDailyDeficit({
            dailyDeficit: parsedDailyDeficit,
            startWeightGrams: start_weight_grams,
            targetWeightGrams: target_weight_grams
        });
        if (coherenceError) {
            return res.status(400).json({ message: coherenceError, code: 'CALORIE_PLAN_OPTION_UNAVAILABLE', retryable: false, field_errors: { target_weight: [coherenceError] } });
        }

        let parsedTargetDate: Date | null = null;
        if (target_date) {
            const candidate = new Date(target_date);
            if (Number.isNaN(candidate.getTime())) {
                return res.status(400).json({ message: 'Invalid target_date' });
            }
            parsedTargetDate = candidate;
        }

        const result = await executeIdempotentMutation<unknown>({
            userId: user.id,
            operationId,
            operationKind: 'goal.create',
            transactionOptions: { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
            requestPayload: req.body,
            mutate: async (tx, claimedOperationId) => {
                await lockCaloriePlanningInputs(tx, user.id);
                const snapshot = await buildStoredCaloriePlanningSnapshot(tx, user.id);
                if (!snapshot) return { status: 404, body: { message: 'User not found' } };
                const evaluation = evaluateCaloriePlan({
                    profile: {
                        timezone: snapshot.user.timezone,
                        dateOfBirth: snapshot.user.date_of_birth,
                        sex: snapshot.user.sex,
                        heightMm: snapshot.user.height_mm,
                        activityLevel: snapshot.user.activity_level
                    },
                    latestWeightGrams: snapshot.latestWeightGrams,
                    goal: {
                        startWeightGrams: start_weight_grams,
                        targetWeightGrams: target_weight_grams,
                        dailyDeficit: parsedDailyDeficit,
                        reviewStatus: 'CLEAR'
                    }
                });
                if (evaluation.eligibility.status !== 'eligible') {
                    return {
                        status: 400,
                        body: {
                            message: 'Complete a valid profile before creating a calorie plan.',
                            code: 'CALORIE_PLAN_PROFILE_REQUIRED',
                            retryable: false,
                            field_errors: { date_of_birth: ['Complete the required profile fields before creating a goal.'] }
                        }
                    };
                }
                if (evaluation.status !== 'available') {
                    return {
                        status: 400,
                        body: {
                            message: 'That calorie plan option is unavailable.',
                            code: 'CALORIE_PLAN_OPTION_UNAVAILABLE',
                            retryable: false,
                            field_errors: { daily_deficit: ['Choose an available calorie plan option.'] }
                        }
                    };
                }
                const goal = await tx.goal.create({
                    data: {
                        user_id: user.id,
                        start_weight_grams,
                        target_weight_grams,
                        target_date: parsedTargetDate,
                        daily_deficit: parsedDailyDeficit,
                        calorie_plan_review_status: 'CLEAR',
                        calorie_plan_review_reason: null
                    }
                });
                await observeCurrentCaloriePlan(tx, user.id);
                await recordSyncChange({
                    tx, userId: user.id, entityType: 'goal', entityId: goal.id, action: 'upsert',
                    operationId: claimedOperationId, payload: goal
                });
                const projection = projectGoalEndDate({
                    planStatus: evaluation.status,
                    planReasonCode: evaluation.reasonCode,
                    localDate: snapshot.localToday,
                    currentWeightGrams: snapshot.latestWeightGrams,
                    targetWeightGrams: goal.target_weight_grams,
                    dailyDeficit: goal.daily_deficit,
                    weightUnit: snapshot.user.weight_unit
                });
                const { start_weight_grams: createdStartWeightGrams, target_weight_grams: createdTargetWeightGrams, ...createdGoal } = goal;
                return {
                    status: 200,
                    body: {
                        ...createdGoal,
                        start_weight: gramsToWeight(createdStartWeightGrams, weightUnit),
                        target_weight: gramsToWeight(createdTargetWeightGrams, weightUnit),
                        plan_status: evaluation.status,
                        plan_reason_code: evaluation.reasonCode,
                        projection: projectionWire(projection)
                    }
                };
            }
        });
        return res.status(result.status).json(result.body);
    } catch (err) {
        if (err instanceof ClientOperationConflictError) {
            return res.status(409).json({
                message: err.message,
                code: err.code,
                retryable: err.code === 'OPERATION_IN_PROGRESS'
            });
        }
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
            return res.status(409).json({
                message: 'Your plan changed during saving. Review the current goal and try again.',
                code: 'GOAL_PLAN_CHANGED', retryable: true
            });
        }
        res.status(500).json({ message: 'Server error' });
    }
});

// This preview always uses stored profile/weight and corrections, never a caller-supplied baseline.
router.get('/pace-options', async (req, res) => {
    try {
        const snapshot = await getStoredCaloriePlanningSnapshot(getAuthenticatedUser(req).id);
        if (!snapshot?.goal) return res.status(404).json({ message: 'No current goal' });
        res.set('Cache-Control', 'no-store');
        return res.json(goalPaceOptions(snapshot));
    } catch {
        return res.status(500).json({ message: 'Unable to check the current goal. Retry the plan check.' });
    }
});

router.patch('/:id/pace', async (req, res) => {
    const user = getAuthenticatedUser(req);
    const operationId = parseClientOperationId(req.get?.('x-client-operation-id') ?? req.headers?.['x-client-operation-id']);
    const deficit = parseDailyDeficit(req.body?.daily_deficit);
    const goalId = Number(req.params.id);
    const version = req.body?.expected_plan_version;
    if (!operationId || !Number.isSafeInteger(goalId) || goalId <= 0 || deficit === null ||
        typeof version !== 'string' || !/^[a-f0-9]{64}$/.test(version) ||
        Object.keys(req.body).some(key => !['daily_deficit', 'expected_plan_version'].includes(key))) {
        return res.status(400).json({ message: 'Refresh the plan check and choose an available daily calorie change.',
            code: 'CALORIE_PLAN_OPTION_UNAVAILABLE', retryable: false });
    }
    try {
        const result = await executeIdempotentMutation<unknown>({
            userId: user.id, operationId, operationKind: 'goal.adjust_pace',
            requestPayload: { goal_id: goalId, daily_deficit: deficit, expected_plan_version: version },
            transactionOptions: { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
            mutate: async (tx, claimedOperationId) => {
                await lockCaloriePlanningInputs(tx, user.id);
                const now = new Date();
                const snapshot = await buildStoredCaloriePlanningSnapshot(tx, user.id, now);
                if (!snapshot?.goal || snapshot.goal.id !== goalId || goalPaceVersion(snapshot) !== version) {
                    return { status: 409, body: { message: 'Your goal or calorie plan changed. Refresh the plan check before saving.',
                        code: 'GOAL_PLAN_CHANGED', retryable: false } };
                }
                const option = goalPaceOptions(snapshot, now).planOptions.find(item => item.dailyDeficit === deficit);
                if (!option?.available || !snapshot.localToday) {
                    return { status: 400, body: { message: 'That calorie plan option is unavailable. Review the current plan before adjusting its pace.',
                        code: 'CALORIE_PLAN_OPTION_UNAVAILABLE', retryable: false } };
                }
                if (snapshot.goal.daily_deficit === deficit) return { status: 200, body: goalWire(snapshot) };
                const revision = await tx.caloriePlanRevision.create({ data: {
                    user_id: user.id, source_goal_id: goalId, configured_daily_deficit: deficit,
                    target_adjustment_kcal: snapshot.effectiveRevision?.target_adjustment_kcal ?? 0,
                    effective_local_date: parseLocalDateOnly(snapshot.localToday)
                } });
                await tx.calibrationRecommendation.updateMany({
                    where: { user_id: user.id, status: 'PENDING' }, data: { status: 'STALE' }
                });
                const updated = await buildStoredCaloriePlanningSnapshot(tx, user.id, now);
                if (updated) await retainDailyCaloriePlan(tx, updated, now);
                const body = goalWire(updated!);
                await recordSyncChange({ tx, userId: user.id, entityType: 'goal', entityId: goalId,
                    action: 'upsert', operationId: claimedOperationId, payload: updated!.goal });
                await recordSyncChange({ tx, userId: user.id, entityType: 'calorie_plan_revision', entityId: revision.id,
                    action: 'upsert', operationId: claimedOperationId, payload: revision });
                return { status: 200, body };
            }
        });
        return res.status(result.status).json(result.body);
    } catch (error) {
        if (error instanceof ClientOperationConflictError) {
            return res.status(409).json({ message: error.message, code: error.code, retryable: error.code === 'OPERATION_IN_PROGRESS' });
        }
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
            return res.status(409).json({ message: 'Your plan changed during saving. Refresh the plan check and try again.', code: 'GOAL_PLAN_CHANGED', retryable: false });
        }
        return res.status(500).json({ message: 'Unable to confirm the saved pace. Retry to check the same change.', retryable: true });
    }
});

export default router;
