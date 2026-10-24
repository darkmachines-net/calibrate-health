/** @file Transactional calibration evidence, recommendation acceptance, and scheduled target correction lifecycle. */

import { lockCaloriePlanningInputs } from './caloriePlanningLock';
import { observeCurrentCaloriePlan } from './dailyCaloriePlans';
import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
    CALIBRATION_ASSESSMENT_VERSION,
    CALIBRATION_MAX_OBSERVATION_DAYS,
    CALIBRATION_MIN_TARGET_KCAL,
    CALIBRATION_MODEL_VERSION,
    evaluateCalibration,
    type CalibrationFoodDay,
    type CalibrationInput,
    type CalibrationResult
} from '../../../shared/calibration';
import prisma from '../config/database';
import { CALORIE_POLICY_VERSION, isPolicyWeight, type CaloriePlanReasonCode, type CaloriePlanStatus } from '../../../shared/caloriePolicy';
import { buildStoredCaloriePlanningSnapshot } from './caloriePlanning';
import {
    addUtcDays,
    formatDateToLocalDateString,
    getSafeUtcTodayDateOnlyInTimeZone,
    parseLocalDateOnly
} from '../utils/date';
import {
    ClientOperationConflictError,
    executeIdempotentMutation,
    recordSyncChange,
    type MutationDatabase
} from './clientOperations';
import { WEIGHT_TREND_MODEL_VERSION } from './weightTrend';

const CALIBRATION_HISTORY_DAYS = 90; // Includes the bounded personal intake reference horizon.
// One boundary day lets the largest food window support a full 42 elapsed days of pace evidence.
const CALIBRATION_WEIGHT_LOOKBACK_DAYS = CALIBRATION_MAX_OBSERVATION_DAYS + 1;
const CALIBRATION_APPLY_MAX_ATTEMPTS = 3;

type MaterializedRecommendation = {
    id: number;
    status: 'pending';
    inputFingerprint: string;
    effectiveLocalDate: string;
};

export type ScheduledCalibrationChange = {
    recommendationId: number | null;
    targetAdjustmentKcal: number;
    dailyCalorieBudgetKcal: number | null;
    effectiveLocalDate: string;
};

export type CalibrationStatus = {
    generatedAt: string;
    inputFingerprint: string | null;
    evaluation: CalibrationResult;
    recommendation: MaterializedRecommendation | null;
    scheduledChange: ScheduledCalibrationChange | null;
    planStatus: CaloriePlanStatus;
    planReasonCode: CaloriePlanReasonCode | null;
};

export class CalibrationConflictError extends Error {
    /** Identify a stale calibration decision that callers must refresh before another apply or undo attempt. */
    constructor(message: string) {
        super(message);
        this.name = 'CalibrationConflictError';
    }
}
function isRetryableCalibrationApplyConflict(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error
        && String(error.code) === 'P2034';
}

async function retryCalibrationApply<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= CALIBRATION_APPLY_MAX_ATTEMPTS; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            if (!isRetryableCalibrationApplyConflict(error) || attempt === CALIBRATION_APPLY_MAX_ATTEMPTS) {
                throw error;
            }
        }
    }
    throw new Error('Calibration recommendation apply exhausted its bounded retry loop.');
}


function toDateKey(date: Date): string {
    return date.toISOString().slice(0, 10);
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object' && !(value instanceof Date)) {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, entry]) => [key, canonicalize(entry)])
        );
    }
    return value instanceof Date ? value.toISOString() : value;
}

function fingerprintInput(value: unknown): string {
    return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value)), 'utf8').digest('hex');
}

function buildUnavailableEvaluation(options: {
    asOfDate: string;
    headline: string;
    summary: string;
    missingCriteria: string[];
    weightUnit: 'KG' | 'LB';
    configuredDailyDeficitKcal?: number;
    blocker?: 'plan_unavailable' | 'trend_unavailable';
}): CalibrationResult {
    return {
        modelVersion: CALIBRATION_MODEL_VERSION,
        asOfDate: options.asOfDate,
        weightUnit: options.weightUnit,
        status: 'not_ready',
        headline: options.headline,
        summary: options.summary,
        nextStep: null,
        historyProgress: null,
        selectedWindowDays: null,
        dataQuality: {
            observationDays: 0,
            completeDays: 0,
            confidentDays: 0,
            suspiciousDays: 0,
            incompleteDays: 0,
            missingDays: 0,
            weightPoints: 0,
            weightSpanDays: 0
        },
        missingCriteria: options.missingCriteria,
        assumptions: [],
        estimates: {
            averageIntakeKcal: null,
            observedWeeklyWeightChangeKg: null,
            targetAdjustmentKcal: null,
            configuredWeeklyWeightChangeKg: -((options.configuredDailyDeficitKcal ?? 0) * 7) / 7700
        },
        recommendation: null,
        activityContext: null,
        assessment: {
            version: CALIBRATION_ASSESSMENT_VERSION,
            state: 'waiting',
            paceStatus: null,
            window: null,
            recentWeightTrendKgPerWeek: null,
            goalRateKgPerWeek: -((options.configuredDailyDeficitKcal ?? 0) * 7) / 7700,
            blocker: options.blocker ?? 'plan_unavailable',
            targetDecision: 'waiting',
            targetDecisionBlocker: null,
            minimumDailyCalorieTargetKcal: CALIBRATION_MIN_TARGET_KCAL
        }
    };
}

async function stalePendingRecommendations(database: MutationDatabase, userId: number): Promise<void> {
    await database.calibrationRecommendation.updateMany({
        where: { user_id: userId, status: 'PENDING' },
        data: { status: 'STALE' }
    });
}

function buildFoodEvidence(options: {
    logs: Array<{ local_date: Date; calories: number; meal_period: string }>;
    completionDays: Array<{ local_date: Date; status: string }>;
    planStartDate: string;
    asOfDate: string;
}): CalibrationFoodDay[] {
    const byDate = new Map<string, CalibrationFoodDay>();
    for (const completion of options.completionDays) {
        const date = toDateKey(completion.local_date);
        if (date < options.planStartDate || date > options.asOfDate) continue;
        byDate.set(date, {
            date,
            calories: 0,
            entryCount: 0,
            mealPeriodCount: 0,
            isComplete: completion.status === 'COMPLETE',
            isPaused: completion.status === 'PAUSED'
        });
    }
    const mealPeriodsByDate = new Map<string, Set<string>>();
    for (const log of options.logs) {
        const date = toDateKey(log.local_date);
        if (date < options.planStartDate || date > options.asOfDate) continue;
        const day = byDate.get(date) ?? {
            date,
            calories: 0,
            entryCount: 0,
            mealPeriodCount: 0,
            isComplete: false,
            isPaused: false
        };
        day.calories += log.calories;
        day.entryCount += 1;
        const mealPeriods = mealPeriodsByDate.get(date) ?? new Set<string>();
        mealPeriods.add(log.meal_period);
        mealPeriodsByDate.set(date, mealPeriods);
        day.mealPeriodCount = mealPeriods.size;
        byDate.set(date, day);
    }
    return Array.from(byDate.values()).sort((left, right) => left.date.localeCompare(right.date));
}

function buildWeightEvidence(options: {
    rows: Array<{
        date: Date;
        weight_grams: number;
    }>;
    planStartDate: string;
    latestPausedDate: string | null;
}): CalibrationInput['weightPoints'] {
    const rows = options.rows.filter((row) => {
        const date = toDateKey(row.date);
        return date >= options.planStartDate && (!options.latestPausedDate || date > options.latestPausedDate);
    });
    return rows.map((row) => ({
        date: toDateKey(row.date),
        weightKg: row.weight_grams / 1000
    }));
}

async function materializeRecommendation(options: {
    database: MutationDatabase;
    userId: number;
    goalId: number;
    inputFingerprint: string;
    asOfDate: Date;
    effectiveLocalDate: Date;
    evaluation: CalibrationResult;
}): Promise<MaterializedRecommendation | null> {
    const suggested = options.evaluation.recommendation;
    if (!suggested) {
        await stalePendingRecommendations(options.database, options.userId);
        return null;
    }

    await options.database.calibrationRecommendation.updateMany({
            where: {
                user_id: options.userId,
                status: 'PENDING',
                input_fingerprint: { not: options.inputFingerprint }
            },
            data: { status: 'STALE' }
        });
    const recommendation = await options.database.calibrationRecommendation.upsert({
            where: {
                user_id_input_fingerprint: {
                    user_id: options.userId,
                    input_fingerprint: options.inputFingerprint
                }
            },
            update: {},
            create: {
                user_id: options.userId,
                source_goal_id: options.goalId,
                input_fingerprint: options.inputFingerprint,
                model_version: options.evaluation.modelVersion,
                as_of_local_date: options.asOfDate,
                current_target_adjustment_kcal: suggested.currentTargetAdjustmentKcal,
                recommended_target_adjustment_kcal: suggested.recommendedTargetAdjustmentKcal,
                current_target_kcal: suggested.currentTargetKcal,
                recommended_target_kcal: suggested.recommendedTargetKcal,
                result_snapshot: JSON.parse(JSON.stringify(options.evaluation)) as Prisma.InputJsonValue
            }
        });

    if (recommendation.status !== 'PENDING') return null;
    return {
        id: recommendation.id,
        status: 'pending',
        inputFingerprint: recommendation.input_fingerprint,
        effectiveLocalDate: toDateKey(options.effectiveLocalDate)
    };
}

/** Compute one planning-and-evidence snapshot on the caller's transaction connection. */
async function buildCalibrationStatusSnapshot(
    database: MutationDatabase,
    userId: number,
    now: Date,
    persistRecommendation: boolean
): Promise<CalibrationStatus> {
    const planning = await buildStoredCaloriePlanningSnapshot(database, userId, now);
    if (!planning) throw new CalibrationConflictError('User not found.');
    const user = planning.user;
    const today = planning.localToday
        ? parseLocalDateOnly(planning.localToday)
        : new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
    const generatedAt = now.toISOString();
    const unavailableAsOfDate = addUtcDays(today, -1);
    const unavailableAsOfDateKey = toDateKey(unavailableAsOfDate);

    if (planning.evaluation.status !== 'available') {
        if (persistRecommendation) await stalePendingRecommendations(database, userId);
        return {
            generatedAt,
            inputFingerprint: null,
            evaluation: buildUnavailableEvaluation({
                asOfDate: unavailableAsOfDateKey,
                headline: 'Calorie planning needs review',
                summary: 'Calibration is unavailable until the current calorie plan is safe and eligible.',
                missingCriteria: [planning.evaluation.reasonCode ?? 'Review the current calorie plan.'],
                weightUnit: user.weight_unit,
                configuredDailyDeficitKcal: planning.goal?.daily_deficit
            }),
            recommendation: null,
            scheduledChange: planning.nextRevision ? {
                recommendationId: planning.nextRevision.recommendation_id,
                targetAdjustmentKcal: planning.nextRevision.target_adjustment_kcal,
                dailyCalorieBudgetKcal: null,
                effectiveLocalDate: toDateKey(planning.nextRevision.effective_local_date)
            } : null,
            planStatus: planning.evaluation.status,
            planReasonCode: planning.evaluation.reasonCode
        };
    }

    const goal = planning.goal!;

    const todayCompletion = await database.foodLogDay.findUnique({
        where: { user_id_local_date: { user_id: userId, local_date: today } },
        select: { status: true }
    });
    // An in-progress current day is not evidence of a missing log. Once completed, it participates immediately.
    const asOfDate = todayCompletion?.status === 'COMPLETE' ? today : addUtcDays(today, -1);
    const asOfDateKey = toDateKey(asOfDate);
    const historyStart = addUtcDays(asOfDate, -(CALIBRATION_HISTORY_DAYS - 1));
    const weightStart = addUtcDays(asOfDate, -(CALIBRATION_WEIGHT_LOOKBACK_DAYS - 1));
    const currentPlan = planning.effectiveRevision ? {
        targetAdjustmentKcal: planning.effectiveRevision.target_adjustment_kcal,
        effectiveLocalDate: planning.effectiveRevision.effective_local_date
    } : null;
    const [scheduledRevision, logs, completionDays, weightRows] = await Promise.all([
        database.caloriePlanRevision.findFirst({
            where: { user_id: userId, source_goal_id: goal.id, effective_local_date: { gt: today } },
            orderBy: [{ effective_local_date: 'asc' }, { id: 'asc' }],
            select: { recommendation_id: true, target_adjustment_kcal: true, effective_local_date: true, calorie_plan_review_status: true, calorie_plan_review_reason: true }
        }),
        database.foodLog.findMany({
            where: { user_id: userId, local_date: { gte: historyStart, lte: asOfDate } },
            orderBy: [{ local_date: 'asc' }, { id: 'asc' }],
            select: { local_date: true, calories: true, meal_period: true }
        }),
        database.foodLogDay.findMany({
            where: { user_id: userId, local_date: { gte: historyStart, lte: asOfDate } },
            orderBy: { local_date: 'asc' },
            select: { local_date: true, status: true }
        }),
        database.bodyMetric.findMany({
            where: { user_id: userId, date: { gte: weightStart, lte: asOfDate } },
            orderBy: [{ date: 'asc' }, { id: 'asc' }],
            select: {
                date: true,
                weight_grams: true
            }
        })
    ]);

    const bmrKcal = planning.evaluation.bmr!;
    const profileTdeeKcal = planning.evaluation.tdee!;
    if (weightRows.some((row) => !isPolicyWeight(row.weight_grams))) {
        if (persistRecommendation) await stalePendingRecommendations(database, userId);
        return {
            generatedAt,
            inputFingerprint: null,
            evaluation: buildUnavailableEvaluation({
                asOfDate: asOfDateKey,
                headline: 'Calibration needs valid weight history',
                blocker: 'trend_unavailable',
                summary: 'A weight in the calibration window is outside the supported range, so no calorie adjustment can be generated.',
                missingCriteria: ['Review weight entries outside the supported range.'],
                weightUnit: user.weight_unit,
                configuredDailyDeficitKcal: goal.daily_deficit
            }),
            recommendation: null,
            scheduledChange: scheduledRevision ? {
                recommendationId: scheduledRevision.recommendation_id,
                targetAdjustmentKcal: scheduledRevision.target_adjustment_kcal,
                dailyCalorieBudgetKcal: null,
                effectiveLocalDate: toDateKey(scheduledRevision.effective_local_date)
            } : null,
            planStatus: planning.evaluation.status,
            planReasonCode: planning.evaluation.reasonCode
        };
    }
    const goalStartDate = formatDateToLocalDateString(goal.created_at, user.timezone);
    // A manual pace change can occur after logging/completion; start new calibration evidence with the next full day.
    const revisionStartDate = currentPlan
        ? toDateKey(planning.effectiveRevision?.configured_daily_deficit != null
            ? addUtcDays(currentPlan.effectiveLocalDate, 1)
            : currentPlan.effectiveLocalDate)
        : goalStartDate;
    const planStartDate = goalStartDate > revisionStartDate ? goalStartDate : revisionStartDate;
    const foodDays = buildFoodEvidence({ logs, completionDays, planStartDate, asOfDate: asOfDateKey });
    const latestPausedDate = foodDays
        .filter((day) => day.isPaused)
        .map((day) => day.date)
        .sort((left, right) => right.localeCompare(left))[0] ?? null;
    const input: CalibrationInput = {
        asOfDate: asOfDateKey,
        weightUnit: user.weight_unit,
        ageYears: planning.evaluation.eligibility.ageYears!,
        bmrKcal,
        profileTdeeKcal,
        configuredDailyDeficitKcal: goal.daily_deficit,
        currentTargetAdjustmentKcal: currentPlan?.targetAdjustmentKcal ?? 0,
        foodDays,
        trackingPaused: todayCompletion?.status === 'PAUSED',
        weightPoints: buildWeightEvidence({ rows: weightRows, planStartDate, latestPausedDate })
    };
    const scheduledTarget = scheduledRevision
        ? Math.round(profileTdeeKcal - goal.daily_deficit + scheduledRevision.target_adjustment_kcal)
        : null;
    const scheduledChange = scheduledRevision ? {
        recommendationId: scheduledRevision.recommendation_id,
        targetAdjustmentKcal: scheduledRevision.target_adjustment_kcal,
        dailyCalorieBudgetKcal:
            scheduledRevision.calorie_plan_review_status === 'CLEAR' && scheduledTarget !== null &&
            scheduledTarget >= planning.evaluation.minimumDailyCalorieTarget!
                ? scheduledTarget
                : null,
        effectiveLocalDate: toDateKey(scheduledRevision.effective_local_date)
    } : null;
    if (WEIGHT_TREND_MODEL_VERSION !== 2) {
        if (persistRecommendation) await stalePendingRecommendations(database, userId);
        return {
            generatedAt,
            inputFingerprint: null,
            evaluation: buildUnavailableEvaluation({
                asOfDate: asOfDateKey,
                headline: 'Calibration is temporarily unavailable',
                blocker: 'trend_unavailable',
                summary: 'The active compatibility weight trend does not provide the pace uncertainty needed for safe calorie-budget suggestions. Existing approved plan changes remain in effect.',
                missingCriteria: ['Calibration resumes when the current weight-trend model is available.'],
                weightUnit: user.weight_unit,
                configuredDailyDeficitKcal: goal.daily_deficit
            }),
            recommendation: null,
            scheduledChange,
            planStatus: planning.evaluation.status,
            planReasonCode: planning.evaluation.reasonCode
        };
    }
    const evaluation = evaluateCalibration(input);
    const { weightUnit: _displayWeightUnit, ...actionEvidence } = input;
    const inputFingerprint = fingerprintInput({
        modelVersion: CALIBRATION_MODEL_VERSION,
        caloriePolicyVersion: CALORIE_POLICY_VERSION,
        goalId: goal.id,
        planStartDate,
        actionEvidence
    });
    let recommendation: MaterializedRecommendation | null = null;
    if (scheduledChange) {
        if (persistRecommendation) await stalePendingRecommendations(database, userId);
    } else if (persistRecommendation) {
        recommendation = await materializeRecommendation({
            database,
            userId,
            goalId: goal.id,
            inputFingerprint,
            asOfDate,
            effectiveLocalDate: addUtcDays(today, 1),
            evaluation
        });
    } else if (evaluation.recommendation) {
        // Apply uses this transaction-local candidate only to compare the complete current fingerprint.
        recommendation = {
            id: 0,
            status: 'pending',
            inputFingerprint,
            effectiveLocalDate: toDateKey(addUtcDays(today, 1))
        };
    }

    return { generatedAt, inputFingerprint, evaluation, recommendation, scheduledChange, planStatus: planning.evaluation.status, planReasonCode: planning.evaluation.reasonCode };
}
/** Compute and, when actionable, materialize the latest user-specific calibration status. */
export function buildCalibrationStatus(userId: number, now = new Date()): Promise<CalibrationStatus> {
    return prisma.$transaction(
        (tx) => buildCalibrationStatusSnapshot(tx, userId, now, true),
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
    );
}


/** Revalidate and accept one current recommendation as a next-local-day plan revision. */
export async function applyCalibrationRecommendation(options: {
    userId: number;
    recommendationId: number;
    operationId?: string;
    now?: Date;
}): Promise<ScheduledCalibrationChange> {
    try {
        const result = await retryCalibrationApply(() => executeIdempotentMutation<ScheduledCalibrationChange>({
            userId: options.userId,
            operationId: options.operationId,
            operationKind: 'calibration_recommendation.apply',
            requestPayload: { recommendation_id: options.recommendationId },
            transactionOptions: { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
            mutate: async (tx, claimedOperationId) => {
                await lockCaloriePlanningInputs(tx, options.userId);
                const recommendation = await tx.calibrationRecommendation.findFirst({
                    where: { id: options.recommendationId, user_id: options.userId },
                    include: { plan_revision: true }
                });
                if (!recommendation) {
                    throw new CalibrationConflictError('This recommendation is no longer current. Refresh calibration before applying it.');
                }

                if (recommendation.status === 'APPLIED' && recommendation.plan_revision) {
                    const planning = await buildStoredCaloriePlanningSnapshot(tx, options.userId, options.now ?? new Date());
                    if (
                        !planning ||
                        planning.evaluation.status !== 'available' ||
                        recommendation.source_goal_id !== planning.goal?.id
                    ) {
                        throw new CalibrationConflictError('This recommendation no longer matches the current calorie plan.');
                    }
                    const expectedTarget = Math.round(
                        planning.evaluation.tdee! -
                        planning.goal.daily_deficit +
                        recommendation.recommended_target_adjustment_kcal
                    );
                    if (
                        expectedTarget !== recommendation.recommended_target_kcal ||
                        recommendation.plan_revision.calorie_plan_review_status === 'REQUIRES_REVIEW' ||
                        recommendation.recommended_target_kcal < planning.evaluation.minimumDailyCalorieTarget!
                    ) {
                        throw new CalibrationConflictError('The applied calorie plan revision is no longer safe.');
                    }
                    return {
                        status: 200,
                        body: {
                            recommendationId: recommendation.id,
                            targetAdjustmentKcal: recommendation.plan_revision.target_adjustment_kcal,
                            dailyCalorieBudgetKcal: recommendation.recommended_target_kcal,
                            effectiveLocalDate: toDateKey(recommendation.plan_revision.effective_local_date)
                        }
                    };
                }
                if (recommendation.status !== 'PENDING') {
                    throw new CalibrationConflictError('This recommendation is no longer current. Refresh calibration before applying it.');
                }

                const status = await buildCalibrationStatusSnapshot(
                    tx,
                    options.userId,
                    options.now ?? new Date(),
                    false
                );
                const currentSuggestion = status.evaluation.recommendation;
                if (!status.recommendation || !currentSuggestion) {
                    throw new CalibrationConflictError('This recommendation is no longer current. Refresh calibration before applying it.');
                }
                if (
                    recommendation.current_target_adjustment_kcal !== currentSuggestion.currentTargetAdjustmentKcal ||
                    recommendation.recommended_target_adjustment_kcal !== currentSuggestion.recommendedTargetAdjustmentKcal ||
                    recommendation.current_target_kcal !== currentSuggestion.currentTargetKcal ||
                    recommendation.recommended_target_kcal !== currentSuggestion.recommendedTargetKcal) {
                    throw new CalibrationConflictError('The current calorie plan requires review before a recommendation can be applied.');
                }
                if (recommendation.input_fingerprint !== status.inputFingerprint ||
                    recommendation.model_version !== status.evaluation.modelVersion ||
                    toDateKey(recommendation.as_of_local_date) !== status.evaluation.asOfDate) {
                    throw new CalibrationConflictError('This recommendation is no longer current. Refresh calibration before applying it.');
                }
                const effectiveLocalDate = parseLocalDateOnly(status.recommendation.effectiveLocalDate);
                const revision = await tx.caloriePlanRevision.create({
                    data: {
                        user_id: options.userId,
                        source_goal_id: recommendation.source_goal_id,
                        recommendation_id: recommendation.id,
                        target_adjustment_kcal: recommendation.recommended_target_adjustment_kcal,
                        calorie_plan_review_status: 'CLEAR',
                        calorie_plan_review_reason: null,
                        effective_local_date: effectiveLocalDate
                    }
                });
                await tx.calibrationRecommendation.update({
                    where: { id: recommendation.id },
                    data: { status: 'APPLIED', applied_at: options.now ?? new Date() }
                });
                await observeCurrentCaloriePlan(tx, options.userId, options.now);
                const body = {
                    recommendationId: recommendation.id,
                    targetAdjustmentKcal: revision.target_adjustment_kcal,
                    dailyCalorieBudgetKcal: recommendation.recommended_target_kcal,
                    effectiveLocalDate: toDateKey(revision.effective_local_date)
                };
                await recordSyncChange({
                    tx,
                    userId: options.userId,
                    entityType: 'calorie_plan_revision',
                    entityId: revision.id,
                    action: 'upsert',
                    operationId: claimedOperationId,
                    payload: body
                });
                return { status: 200, body };
            }
        }));
        return result.body;
    } catch (error) {
        if (error instanceof ClientOperationConflictError) throw error;
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw new CalibrationConflictError('This recommendation has already been applied.');
        }
        throw error;
    }
}

/** Undo a not-yet-effective calibration revision and restore its recommendation for review. */
export async function cancelScheduledCalibrationChange(options: {
    userId: number;
    recommendationId: number;
    operationId?: string;
    now?: Date;
}): Promise<CalibrationStatus> {
    const user = await prisma.user.findUnique({
        where: { id: options.userId },
        select: { timezone: true }
    });
    if (!user) throw new CalibrationConflictError('User not found.');

    const today = getSafeUtcTodayDateOnlyInTimeZone(user.timezone, options.now ?? new Date());
    await executeIdempotentMutation<{ recommendationId: number; canceled: true }>({
        userId: options.userId,
        operationId: options.operationId,
        operationKind: 'calibration_recommendation.cancel',
        requestPayload: { recommendation_id: options.recommendationId },
        mutate: async (tx, claimedOperationId) => {
            await lockCaloriePlanningInputs(tx, options.userId);
            const recommendation = await tx.calibrationRecommendation.findFirst({
                where: {
                    id: options.recommendationId,
                    user_id: options.userId,
                    status: 'APPLIED'
                },
                include: { plan_revision: true }
            });
            const revision = recommendation?.plan_revision;
            if (!recommendation || !revision) {
                throw new CalibrationConflictError('This calorie budget update is no longer scheduled. Refresh calibration to see the latest plan.');
            }
            if (revision.effective_local_date <= today) {
                throw new CalibrationConflictError('This calorie budget update has already started and can no longer be undone as a scheduled change.');
            }

            await tx.caloriePlanRevision.delete({ where: { id: revision.id } });
            await tx.calibrationRecommendation.update({
                where: { id: recommendation.id },
                data: { status: 'PENDING', applied_at: null }
            });
            await observeCurrentCaloriePlan(tx, options.userId, options.now);
            await recordSyncChange({
                tx,
                userId: options.userId,
                entityType: 'calorie_plan_revision',
                entityId: revision.id,
                action: 'delete',
                operationId: claimedOperationId,
                payload: {
                    recommendationId: recommendation.id,
                    effectiveLocalDate: toDateKey(revision.effective_local_date)
                }
            });
            return {
                status: 200,
                body: { recommendationId: recommendation.id, canceled: true }
            };
        }
    });

    return buildCalibrationStatus(options.userId, options.now);
}
