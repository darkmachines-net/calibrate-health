/** @file Evidence-based calorie-target calibration that preserves profile-estimated TDEE and configured deficit. */

import type { WeightUnit } from './domain';
import { computeWeightTrend } from './weightTrend';
import { ABSOLUTE_MIN_TARGET_KCAL, minimumTargetForBmr } from './caloriePolicy';

export const CALIBRATION_MODEL_VERSION = 4;
export const CALIBRATION_MAX_OBSERVATION_DAYS = 42;
export const CALIBRATION_REFERENCE_DAYS = 90;
export const CALIBRATION_MIN_INSIGHT_DAYS = 7;
export const CALIBRATION_MIN_ACTIONABLE_DAYS = 14;
export const CALIBRATION_MAX_ADJUSTMENT_STEP_KCAL = 150;
export const CALIBRATION_MIN_TARGET_KCAL = ABSOLUTE_MIN_TARGET_KCAL;
export const CALIBRATION_BOOTSTRAP_REPLICATES = 400;
export const CALIBRATION_ASSESSMENT_VERSION = 1;

const KCAL_PER_KILOGRAM = 7700;
const ACTION_THRESHOLD_KCAL = 75;
const MAX_ACTIONABLE_INTERVAL_WIDTH_KCAL = 300;
const OBSERVATION_WINDOWS = [14, 21, 28, 35, 42] as const;
const POUNDS_PER_KILOGRAM = 2.2046226218;

export type CalibrationFoodDay = {
    date: string;
    calories: number;
    entryCount: number;
    mealPeriodCount: number;
    isComplete: boolean;
    isPaused?: boolean;
};

export type CalibrationWeightPoint = {
    date: string;
    /** Canonical daily scale reading. Trend and pace uncertainty are fitted inside each evidence window. */
    weightKg: number;
};

export type CalibrationActivityDay = {
    date: string;
    steps?: number | null;
    activeCaloriesKcal?: number | null;
};

export type CalibrationInput = {
    asOfDate: string;
    weightUnit: WeightUnit;
    ageYears: number;
    bmrKcal: number;
    profileTdeeKcal: number;
    configuredDailyDeficitKcal: number;
    currentTargetAdjustmentKcal: number;
    foodDays: CalibrationFoodDay[];
    weightPoints: CalibrationWeightPoint[];
    activityDays?: CalibrationActivityDay[];
    trackingPaused?: boolean;
};

export type CalibrationInterval = {
    low: number;
    midpoint: number;
    high: number;
};

export type CalibrationDataQuality = {
    observationDays: number;
    completeDays: number;
    confidentDays: number;
    suspiciousDays: number;
    incompleteDays: number;
    missingDays: number;
    weightPoints: number;
    weightSpanDays: number;
};

export type CalibrationRecommendation = {
    currentTargetKcal: number;
    recommendedTargetKcal: number;
    adjustmentStepKcal: number;
    currentTargetAdjustmentKcal: number;
    recommendedTargetAdjustmentKcal: number;
};

export type CalibrationPaceStatus =
    | 'faster'
    | 'aligned'
    | 'slower'
    | 'above_maintenance'
    | 'below_maintenance';

export type CalibrationAssessmentBlocker =
    | 'tracking_paused'
    | 'plan_unavailable'
    | 'trend_unavailable'
    | 'weight_history'
    | 'current_weigh_in'
    | 'food_history'
    | 'food_uncertainty'
    | 'weight_uncertainty';

export type CalibrationTargetDecision =
    | 'waiting'
    | 'no_change_recommended'
    | 'change_available'
    | 'safety_limited'
    | 'policy_unavailable';

export type CalibrationAssessment = {
    version: 1;
    state: 'waiting' | 'on_track' | 'off_track';
    paceStatus: CalibrationPaceStatus | null;
    window: {
        startDate: string;
        endDate: string;
        spanDays: number;
        confidenceLevel: 0.95;
    } | null;
    recentWeightTrendKgPerWeek: CalibrationInterval | null;
    goalRateKgPerWeek: number;
    blocker: CalibrationAssessmentBlocker | null;
    targetDecision: CalibrationTargetDecision;
    targetDecisionBlocker: CalibrationAssessmentBlocker | null;
    minimumDailyCalorieTargetKcal: number;
};

export type CalibrationResult = {
    modelVersion: number;
    asOfDate: string;
    weightUnit: WeightUnit;
    status: 'not_ready' | 'learning' | 'insight' | 'recommendation';
    headline: string;
    summary: string;
    nextStep: string | null;
    historyProgress: {
        stage: 'pace_check' | 'budget_review';
        observedDays: number;
        requiredDays: number;
        completeFoodDays: number;
        requiredCompleteFoodDays: number;
        weightSpanDays: number;
        requiredWeightSpanDays: number;
        weightPoints: number;
        requiredWeightPoints: number;
        restartedAfterPause: boolean;
    } | null;
    selectedWindowDays: number | null;
    dataQuality: CalibrationDataQuality;
    missingCriteria: string[];
    assumptions: string[];
    estimates: {
        averageIntakeKcal: CalibrationInterval | null;
        observedWeeklyWeightChangeKg: CalibrationInterval | null;
        targetAdjustmentKcal: CalibrationInterval | null;
        configuredWeeklyWeightChangeKg: number;
    };
    recommendation: CalibrationRecommendation | null;
    activityContext: {
        observedDays: number;
        averageSteps: number | null;
        averageActiveCaloriesKcal: number | null;
    } | null;
    assessment: CalibrationAssessment;
};

type ClassifiedFoodDay = CalibrationFoodDay & {
    classification: 'confident' | 'suspicious' | 'incomplete' | 'missing';
    low: number;
    high: number;
};

type WindowEvaluation = {
    windowDays: number;
    dataQuality: CalibrationDataQuality;
    averageIntake: CalibrationInterval | null;
    weeklyWeightChange: CalibrationInterval | null;
    weightTrend: CalibrationInterval | null;
    targetAdjustment: CalibrationInterval | null;
    recommendation: CalibrationRecommendation | null;
    actionable: boolean;
    safetyFloorBlocked: boolean;
    missingCriteria: string[];
};

type CalibrationPeriod = {
    input: CalibrationInput;
    restartedAfterPause: boolean;
    startsOn: string | null;
};

function clamp(value: number, low: number, high: number): number {
    return Math.min(high, Math.max(low, value));
}

function round(value: number, precision = 1): number {
    const scale = 10 ** precision;
    return Math.round(value * scale) / scale;
}

function addDateDays(date: string, delta: number): string {
    const parsed = new Date(`${date}T00:00:00.000Z`);
    parsed.setUTCDate(parsed.getUTCDate() + delta);
    return parsed.toISOString().slice(0, 10);
}

function inclusiveDateSpan(start: string, end: string): number {
    const startMs = new Date(`${start}T00:00:00.000Z`).getTime();
    const endMs = new Date(`${end}T00:00:00.000Z`).getTime();
    return Math.max(0, Math.round((endMs - startMs) / 86_400_000) + 1);
}

function getCalibrationPeriod(input: CalibrationInput): CalibrationPeriod {
    const latestPausedDate = input.foodDays
        .filter((day) => day.isPaused && day.date <= input.asOfDate)
        .map((day) => day.date)
        .sort((left, right) => right.localeCompare(left))[0] ?? null;
    if (!latestPausedDate) {
        // A pause started after asOfDate still resets the next evidence window.
        return { input, restartedAfterPause: Boolean(input.trackingPaused), startsOn: null };
    }

    const startsOn = addDateDays(latestPausedDate, 1);
    return {
        input: {
            ...input,
            foodDays: input.foodDays.filter((day) => day.date >= startsOn && !day.isPaused),
            weightPoints: input.weightPoints.filter((point) => point.date >= startsOn),
            activityDays: input.activityDays?.filter((day) => day.date >= startsOn)
        },
        restartedAfterPause: true,
        startsOn
    };
}

function quantile(sorted: number[], fraction: number): number {
    if (sorted.length === 0) return 0;
    if (sorted.length === 1) return sorted[0];
    const position = (sorted.length - 1) * fraction;
    const lowerIndex = Math.floor(position);
    const upperIndex = Math.ceil(position);
    const portion = position - lowerIndex;
    return sorted[lowerIndex] * (1 - portion) + sorted[upperIndex] * portion;
}

function interval(values: number[], precision = 1): CalibrationInterval | null {
    if (values.length === 0) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    return {
        low: round(quantile(sorted, 0.025), precision),
        midpoint: round(quantile(sorted, 0.5), precision),
        high: round(quantile(sorted, 0.975), precision)
    };
}

function seedFromInput(input: CalibrationInput, windowDays: number): number {
    const byDate = <T extends { date: string }>(values: T[]) =>
        values.slice().sort((left, right) => left.date.localeCompare(right.date));
    const foodStartDate = addDateDays(input.asOfDate, -(windowDays - 1));
    const weightStartDate = addDateDays(foodStartDate, -1);
    const canonical = JSON.stringify({
        asOfDate: input.asOfDate,
        windowDays,
        bmrKcal: input.bmrKcal,
        profileTdeeKcal: input.profileTdeeKcal,
        configuredDailyDeficitKcal: input.configuredDailyDeficitKcal,
        currentTargetAdjustmentKcal: input.currentTargetAdjustmentKcal,
        foodDays: byDate(input.foodDays.filter((day) => day.date >= foodStartDate && day.date <= input.asOfDate)),
        weightPoints: byDate(input.weightPoints.filter((point) => (
            point.date >= weightStartDate && point.date <= input.asOfDate
        )))
    });
    let hash = 2166136261;
    for (let index = 0; index < canonical.length; index += 1) {
        hash ^= canonical.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function createRandom(seed: number): () => number {
    let state = seed || 0x6d2b79f5;
    return () => {
        state += 0x6d2b79f5;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
    };
}

/** Draw one standard-normal sample without introducing a runtime dependency. */
function sampleStandardNormal(random: () => number): number {
    const first = Math.max(Number.EPSILON, random());
    const second = random();
    return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

function getReferenceIntakeBounds(input: CalibrationInput): { low: number; midpoint: number; high: number } {
    const referenceStart = addDateDays(input.asOfDate, -(CALIBRATION_REFERENCE_DAYS - 1));
    const plausibleMinimum = Math.max(600, input.bmrKcal * 0.45);
    const plausibleMaximum = Math.max(4500, input.profileTdeeKcal * 1.8);
    const confidentCalories = input.foodDays
        .filter((day) =>
            day.date >= referenceStart &&
            day.date <= input.asOfDate &&
            day.isComplete &&
            day.entryCount >= 2 &&
            day.mealPeriodCount >= 2 &&
            day.calories >= plausibleMinimum &&
            day.calories <= plausibleMaximum
        )
        .map((day) => day.calories)
        .sort((a, b) => a - b);

    if (confidentCalories.length < 3) {
        const midpoint = clamp(
            input.profileTdeeKcal - input.configuredDailyDeficitKcal + input.currentTargetAdjustmentKcal,
            plausibleMinimum,
            plausibleMaximum
        );
        return {
            low: Math.max(plausibleMinimum, midpoint - 350),
            midpoint,
            high: Math.min(plausibleMaximum, midpoint + 750)
        };
    }

    const q1 = quantile(confidentCalories, 0.25);
    const median = quantile(confidentCalories, 0.5);
    const q3 = quantile(confidentCalories, 0.75);
    const iqr = Math.max(100, q3 - q1);
    return {
        low: clamp(q1 - Math.max(200, iqr), plausibleMinimum, plausibleMaximum),
        midpoint: clamp(median, plausibleMinimum, plausibleMaximum),
        high: clamp(q3 + Math.max(500, iqr * 2), plausibleMinimum, plausibleMaximum)
    };
}

function classifyFoodDays(input: CalibrationInput, windowDays: number): ClassifiedFoodDay[] {
    const startDate = addDateDays(input.asOfDate, -(windowDays - 1));
    const sourceByDate = new Map(input.foodDays.map((day) => [day.date, day]));
    const reference = getReferenceIntakeBounds(input);
    const currentTarget = input.profileTdeeKcal - input.configuredDailyDeficitKcal + input.currentTargetAdjustmentKcal;
    const plausibleMinimum = Math.max(600, input.bmrKcal * 0.45);
    const plausibleMaximum = Math.max(4500, input.profileTdeeKcal * 1.8);
    const result: ClassifiedFoodDay[] = [];

    for (let offset = 0; offset < windowDays; offset += 1) {
        const date = addDateDays(startDate, offset);
        const source = sourceByDate.get(date);
        if (!source) {
            const low = Math.max(reference.midpoint, currentTarget);
            result.push({
                date,
                calories: 0,
                entryCount: 0,
                mealPeriodCount: 0,
                isComplete: false,
                classification: 'missing',
                // A skipped log is conservatively treated as at least a typical/target day, not as zero intake.
                low,
                high: Math.max(low, Math.min(plausibleMaximum, Math.max(reference.high, currentTarget + 750)))
            });
            continue;
        }

        const structurallyPlausible =
            source.entryCount >= 2 &&
            source.mealPeriodCount >= 2 &&
            source.calories >= plausibleMinimum &&
            source.calories <= plausibleMaximum;
        if (source.isComplete && structurallyPlausible) {
            const trackingAllowance = Math.max(75, source.calories * 0.05);
            result.push({
                ...source,
                classification: 'confident',
                low: Math.max(0, source.calories - trackingAllowance),
                high: source.calories + trackingAllowance
            });
            continue;
        }

        if (source.isComplete) {
            const low = Math.max(source.calories, reference.low * 0.75);
            result.push({
                ...source,
                classification: 'suspicious',
                low,
                // A suspicious total may itself exceed the normal plausibility ceiling. Preserve
                // what was logged and widen upward instead of creating an inverted range.
                high: Math.max(low, reference.high, source.calories + 500)
            });
            continue;
        }

        const low = Math.max(0, source.calories);
        result.push({
            ...source,
            classification: 'incomplete',
            low,
            high: Math.max(low, reference.high, source.calories + 750)
        });
    }

    return result;
}

function summarizeDataQuality(days: ClassifiedFoodDay[], weights: CalibrationWeightPoint[]): CalibrationDataQuality {
    const firstWeight = weights[0];
    const lastWeight = weights[weights.length - 1];
    return {
        observationDays: days.length,
        completeDays: days.filter((day) => day.isComplete).length,
        confidentDays: days.filter((day) => day.classification === 'confident').length,
        suspiciousDays: days.filter((day) => day.classification === 'suspicious').length,
        incompleteDays: days.filter((day) => day.classification === 'incomplete').length,
        missingDays: days.filter((day) => day.classification === 'missing').length,
        weightPoints: weights.length,
        weightSpanDays: firstWeight && lastWeight
            ? Math.max(0, inclusiveDateSpan(firstWeight.date, lastWeight.date) - 1)
            : 0
    };
}

function evaluateWindow(input: CalibrationInput, windowDays: number): WindowEvaluation {
    const startDate = addDateDays(input.asOfDate, -(windowDays - 1));
    // Pace over N elapsed days needs a boundary weigh-in one local date before the N food days.
    const weightStartDate = addDateDays(startDate, -1);
    const days = classifyFoodDays(input, windowDays);
    const windowWeights = input.weightPoints
        .filter((point) => point.date >= weightStartDate && point.date <= input.asOfDate)
        .slice()
        .sort((a, b) => a.date.localeCompare(b.date));
    const trendResult = computeWeightTrend(windowWeights.map((point) => ({
        date: new Date(`${point.date}T00:00:00.000Z`),
        weight: point.weightKg
    })), {
        asOfDate: new Date(`${input.asOfDate}T23:59:59.999Z`),
        // Energy balance compares average intake with average weight change over the same window;
        // the instantaneous Kalman velocity remains a separate current-momentum estimate.
        calibrationWindow: {
            startDate: new Date(`${weightStartDate}T00:00:00.000Z`),
            endDate: new Date(`${input.asOfDate}T00:00:00.000Z`)
        }
    });
    const latestSegmentId = trendResult.points[trendResult.points.length - 1]?.segmentId;
    const weights = latestSegmentId === undefined
        ? []
        : trendResult.points
            .filter((point) => point.segmentId === latestSegmentId)
            .map<CalibrationWeightPoint>((point) => ({
                date: point.date.toISOString().slice(0, 10),
                weightKg: point.weight
            }));
    const dataQuality = summarizeDataQuality(days, weights);
    const missingCriteria: string[] = [];
    const latestWeightDate = weights[weights.length - 1]?.date;
    const daysSinceLatestWeight = latestWeightDate
        ? Math.max(0, inclusiveDateSpan(latestWeightDate, input.asOfDate) - 1)
        : Number.POSITIVE_INFINITY;

    if (input.ageYears < 18) missingCriteria.push('Calibration recommendations are currently available to adults only.');
    if (dataQuality.weightPoints < 2 || dataQuality.weightSpanDays < CALIBRATION_MIN_INSIGHT_DAYS) {
        missingCriteria.push('Record weights spanning at least 7 days so average weekly weight change can be estimated.');
    } else if (dataQuality.weightPoints < 3) {
        missingCriteria.push('Record at least 3 weights before a calorie-budget adjustment can be assessed.');
    }
    if (dataQuality.confidentDays < Math.min(7, windowDays)) {
        missingCriteria.push('Complete at least 7 plausible food-log days with entries across multiple meals.');
    }
    if (Number.isFinite(daysSinceLatestWeight) && daysSinceLatestWeight > 7) {
        missingCriteria.push('Record a current weigh-in before a calorie-budget adjustment can be assessed.');
    }

    const hasPaceEvidence =
        trendResult.windowAverageRate.status !== 'insufficient' &&
        dataQuality.weightSpanDays >= CALIBRATION_MIN_INSIGHT_DAYS &&
        daysSinceLatestWeight <= 14;
    if (!hasPaceEvidence) {
        return {
            windowDays,
            dataQuality,
            averageIntake: null,
            weeklyWeightChange: null,
            weightTrend: null,
            targetAdjustment: null,
            recommendation: null,
            actionable: false,
            safetyFloorBlocked: false,
            missingCriteria
        };
    }

    if (
        windowDays > CALIBRATION_MIN_INSIGHT_DAYS &&
        (windowDays < CALIBRATION_MIN_ACTIONABLE_DAYS || dataQuality.weightSpanDays < CALIBRATION_MIN_ACTIONABLE_DAYS)
    ) {
        missingCriteria.push('Track food and weight across at least 14 days before a calorie-budget adjustment can be assessed.');
    }

    const random = createRandom(seedFromInput(input, windowDays));
    const averageIntakeSamples: number[] = [];
    const weeklyWeightChangeSamples: number[] = [];
    const adjustmentSamples: number[] = [];
    const weeklyRateMean = trendResult.windowAverageRate.estimateKgPerWeek;
    const weeklyRateStd = Math.max(0, trendResult.windowAverageRate.stdKgPerWeek);

    for (let replicate = 0; replicate < CALIBRATION_BOOTSTRAP_REPLICATES; replicate += 1) {
        let intakeTotal = 0;
        for (let sampleIndex = 0; sampleIndex < days.length; sampleIndex += 1) {
            const sampledDay = days[Math.floor(random() * days.length)];
            intakeTotal += sampledDay.low + random() * (sampledDay.high - sampledDay.low);
        }
        const averageIntake = intakeTotal / days.length;
        const sampledWeeklyWeightChange = weeklyRateMean + weeklyRateStd * sampleStandardNormal(random);
        const dailyWeightChange = sampledWeeklyWeightChange / 7;
        const observedDeficit = -dailyWeightChange * KCAL_PER_KILOGRAM;
        const targetAdjustment = averageIntake + observedDeficit - input.profileTdeeKcal;

        averageIntakeSamples.push(averageIntake);
        weeklyWeightChangeSamples.push(sampledWeeklyWeightChange);
        adjustmentSamples.push(targetAdjustment);
    }

    const averageIntake = interval(averageIntakeSamples);
    const weeklyWeightChange = interval(weeklyWeightChangeSamples, 3);
    const targetAdjustment = interval(adjustmentSamples);
    let recommendation: CalibrationRecommendation | null = null;
    let actionable = false;
    let safetyFloorBlocked = false;

    if (targetAdjustment) {
        const intervalWidth = targetAdjustment.high - targetAdjustment.low;
        const currentAdjustment = input.currentTargetAdjustmentKcal;
        const intervalSupportsDecrease = targetAdjustment.high < currentAdjustment - ACTION_THRESHOLD_KCAL;
        const intervalSupportsIncrease = targetAdjustment.low > currentAdjustment + ACTION_THRESHOLD_KCAL;
        const supportsChange = intervalSupportsDecrease || intervalSupportsIncrease;
        const hasMinimumHistory =
            windowDays >= CALIBRATION_MIN_ACTIONABLE_DAYS &&
            dataQuality.weightSpanDays >= CALIBRATION_MIN_ACTIONABLE_DAYS &&
            dataQuality.weightPoints >= 3 &&
            dataQuality.confidentDays >= 7 &&
            daysSinceLatestWeight <= 7;
        actionable =
            input.ageYears >= 18 &&
            input.configuredDailyDeficitKcal > 0 &&
            hasMinimumHistory &&
            intervalWidth <= MAX_ACTIONABLE_INTERVAL_WIDTH_KCAL &&
            supportsChange;

        if (actionable) {
            const rawStep = targetAdjustment.midpoint - currentAdjustment;
            const boundedStep = clamp(rawStep, -CALIBRATION_MAX_ADJUSTMENT_STEP_KCAL, CALIBRATION_MAX_ADJUSTMENT_STEP_KCAL);
            let roundedStep = Math.round(boundedStep / 25) * 25;
            const baseTarget = input.profileTdeeKcal - input.configuredDailyDeficitKcal;
            const currentTarget = baseTarget + currentAdjustment;
            const minimumTarget = minimumTargetForBmr(input.bmrKcal);
            if (roundedStep < 0) {
                const maximumDecrease = Math.max(0, currentTarget - minimumTarget);
                if (maximumDecrease < 25) {
                    safetyFloorBlocked = true;
                    actionable = false;
                } else {
                    roundedStep = Math.max(roundedStep, -Math.floor(maximumDecrease / 25) * 25);
                }
            }

            if (actionable && Math.abs(roundedStep) >= 25) {
                const recommendedAdjustment = currentAdjustment + roundedStep;
                recommendation = {
                    currentTargetKcal: Math.round(currentTarget),
                    recommendedTargetKcal: Math.round(baseTarget + recommendedAdjustment),
                    adjustmentStepKcal: roundedStep,
                    currentTargetAdjustmentKcal: currentAdjustment,
                    recommendedTargetAdjustmentKcal: recommendedAdjustment
                };
            } else {
                actionable = false;
            }
        }

        if (safetyFloorBlocked) {
            missingCriteria.push("Calibrate's BMR-based limit prevents a lower calorie-budget suggestion.");
        }

        if (hasMinimumHistory && intervalWidth > MAX_ACTIONABLE_INTERVAL_WIDTH_KCAL) {
            missingCriteria.push('The estimated calorie-budget range is still too wide for a safe suggestion.');
        }
        if (dataQuality.suspiciousDays > 0) {
            const count = dataQuality.suspiciousDays;
            missingCriteria.push(`${count} day${count === 1 ? ' was' : 's were'} marked complete but did not provide a plausible full-day total, so ${count === 1 ? 'it widens' : 'they widen'} the estimate.`);
        }
        if (dataQuality.incompleteDays > 0) {
            const count = dataQuality.incompleteDays;
            missingCriteria.push(`${count} day${count === 1 ? ' has' : 's have'} a partial food log, so ${count === 1 ? 'its intake remains' : 'their intake remains'} uncertain.`);
        }
        if (dataQuality.missingDays > 0) {
            const count = dataQuality.missingDays;
            missingCriteria.push(`${count} day${count === 1 ? ' has' : 's have'} no food log, so ${count === 1 ? 'its intake remains' : 'their intake remains'} uncertain.`);
        }
    }

    return {
        windowDays,
        dataQuality,
        averageIntake,
        weeklyWeightChange,
        // Keep the displayed weight interval independent of food-dependent bootstrap draws.
        weightTrend: {
            low: trendResult.windowAverageRate.lower95KgPerWeek,
            midpoint: weeklyRateMean,
            high: trendResult.windowAverageRate.upper95KgPerWeek
        },
        targetAdjustment,
        recommendation,
        actionable: actionable && recommendation !== null,
        safetyFloorBlocked,
        missingCriteria: Array.from(new Set(missingCriteria))
    };
}

function emptyQuality(): CalibrationDataQuality {
    return {
        observationDays: 0,
        completeDays: 0,
        confidentDays: 0,
        suspiciousDays: 0,
        incompleteDays: 0,
        missingDays: 0,
        weightPoints: 0,
        weightSpanDays: 0
    };
}

function buildHistoryProgress(
    dataQuality: CalibrationDataQuality,
    stage: 'pace_check' | 'budget_review',
    restartedAfterPause: boolean
): NonNullable<CalibrationResult['historyProgress']> {
    const requiredDays = stage === 'pace_check' ? CALIBRATION_MIN_INSIGHT_DAYS : CALIBRATION_MIN_ACTIONABLE_DAYS;
    const requiredWeightPoints = stage === 'pace_check' ? 2 : 3;
    const observedDays = Math.min(
        requiredDays,
        dataQuality.observationDays,
        dataQuality.weightSpanDays,
        stage === 'pace_check' ? dataQuality.confidentDays : requiredDays
    );
    return {
        stage,
        observedDays,
        requiredDays,
        completeFoodDays: dataQuality.confidentDays,
        requiredCompleteFoodDays: CALIBRATION_MIN_INSIGHT_DAYS,
        weightSpanDays: dataQuality.weightSpanDays,
        requiredWeightSpanDays: requiredDays,
        weightPoints: dataQuality.weightPoints,
        requiredWeightPoints,
        restartedAfterPause
    };
}

function describeRecommendationPace(observedWeeklyKg: number, configuredWeeklyKg: number): string {
    if (configuredWeeklyKg < -0.01) {
        if (observedWeeklyKg > 0.01) return 'Weight is trending up instead of down';
        return observedWeeklyKg < configuredWeeklyKg
            ? "You're losing weight faster than planned"
            : "You're losing weight, but slower than planned";
    }
    if (configuredWeeklyKg > 0.01) {
        if (observedWeeklyKg < -0.01) return 'Weight is trending down instead of up';
        return observedWeeklyKg > configuredWeeklyKg
            ? "You're gaining weight faster than planned"
            : "You're gaining weight, but slower than planned";
    }
    if (observedWeeklyKg < -0.01) return 'Weight is trending down instead of staying steady';
    return 'Weight is trending up instead of staying steady';
}

function displayWeeklyWeightChange(weeklyKg: number, weightUnit: WeightUnit): { value: number; unit: string } {
    return weightUnit === 'LB'
        ? { value: weeklyKg * POUNDS_PER_KILOGRAM, unit: 'lb' }
        : { value: weeklyKg, unit: 'kg' };
}

function describeWeeklyTrend(weeklyKg: number, weightUnit: WeightUnit): string {
    if (Math.abs(weeklyKg) <= 0.01) return 'weight stayed about steady';
    const display = displayWeeklyWeightChange(weeklyKg, weightUnit);
    return `weight trended ${weeklyKg < 0 ? 'down' : 'up'} about ${Math.abs(display.value).toFixed(2)} ${display.unit} per week`;
}

function capitalizeSentence(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
}

function describeProjectedWeeklyTrend(weeklyKg: number, weightUnit: WeightUnit): string {
    if (Math.abs(weeklyKg) <= 0.01) return 'a steady-weight projection';
    const display = displayWeeklyWeightChange(weeklyKg, weightUnit);
    return `a projected ${weeklyKg < 0 ? 'loss' : 'gain'} of ${Math.abs(display.value).toFixed(2)} ${display.unit} per week`;
}

function describeWeeklyRange(value: CalibrationInterval, weightUnit: WeightUnit): string {
    const low = displayWeeklyWeightChange(value.low, weightUnit);
    const high = displayWeeklyWeightChange(value.high, weightUnit);
    if (value.high < -0.01) {
        return `losing ${Math.abs(high.value).toFixed(2)} to ${Math.abs(low.value).toFixed(2)} ${low.unit} per week`;
    }
    if (value.low > 0.01) {
        return `gaining ${low.value.toFixed(2)} to ${high.value.toFixed(2)} ${low.unit} per week`;
    }
    return `losing up to ${Math.abs(Math.min(0, low.value)).toFixed(2)} or gaining up to ${Math.max(0, high.value).toFixed(2)} ${low.unit} per week`;
}

function averageLoggedIntake(input: CalibrationInput, windowDays: number): number {
    const startDate = addDateDays(input.asOfDate, -(windowDays - 1));
    const loggedDays = input.foodDays.filter((day) =>
        day.date >= startDate &&
        day.date <= input.asOfDate &&
        day.entryCount > 0
    );
    if (loggedDays.length === 0) return 0;
    return Math.round(loggedDays.reduce((sum, day) => sum + day.calories, 0) / loggedDays.length);
}

function assessmentPaceStatus(
    trend: CalibrationInterval | null,
    goalRateKgPerWeek: number,
    configuredDailyDeficitKcal: number
): CalibrationPaceStatus | null {
    if (!trend) return null;
    const dailyWidthKcal = (trend.high - trend.low) * KCAL_PER_KILOGRAM / 7;
    if (dailyWidthKcal > MAX_ACTIONABLE_INTERVAL_WIDTH_KCAL) return null;
    const toleranceKgPerWeek = ACTION_THRESHOLD_KCAL * 7 / KCAL_PER_KILOGRAM;
    const goalLow = goalRateKgPerWeek - toleranceKgPerWeek;
    const goalHigh = goalRateKgPerWeek + toleranceKgPerWeek;
    if (configuredDailyDeficitKcal > 0) {
        if (trend.high < goalLow) return 'faster';
        if (trend.low > goalHigh) return 'slower';
    } else if (configuredDailyDeficitKcal < 0) {
        if (trend.low > goalHigh) return 'faster';
        if (trend.high < goalLow) return 'slower';
    } else {
        if (trend.low > goalHigh) return 'above_maintenance';
        if (trend.high < goalLow) return 'below_maintenance';
    }
    return trend.midpoint >= goalLow &&
        trend.midpoint <= goalHigh
        ? 'aligned'
        : null;
}

function latestWeightAgeDays(input: CalibrationInput): number | null {
    const latestDate = input.weightPoints
        .filter((point) => point.date <= input.asOfDate)
        .map((point) => point.date)
        .sort((left, right) => right.localeCompare(left))[0] ?? null;
    return latestDate === null ? null : inclusiveDateSpan(latestDate, input.asOfDate) - 1;
}

function buildCalibrationAssessment(
    input: CalibrationInput,
    selected: WindowEvaluation | null,
    goalRateKgPerWeek: number
): CalibrationAssessment {
    const base = {
        version: CALIBRATION_ASSESSMENT_VERSION,
        paceStatus: null,
        window: null,
        recentWeightTrendKgPerWeek: null,
        goalRateKgPerWeek,
        blocker: null,
        targetDecision: 'waiting',
        targetDecisionBlocker: null,
        minimumDailyCalorieTargetKcal: minimumTargetForBmr(input.bmrKcal)
    } as const;
    if (input.trackingPaused) {
        return { ...base, state: 'waiting', blocker: 'tracking_paused' };
    }
    if (!selected) {
        return { ...base, state: 'waiting', blocker: 'weight_history' };
    }
    const latestWeightAge = latestWeightAgeDays(input);
    if (latestWeightAge === null ||
        selected.dataQuality.weightPoints < 3 ||
        selected.dataQuality.weightSpanDays < CALIBRATION_MIN_ACTIONABLE_DAYS) {
        return { ...base, state: 'waiting', blocker: 'weight_history' };
    }
    if (latestWeightAge > 7) {
        return { ...base, state: 'waiting', blocker: 'current_weigh_in' };
    }
    if (!selected.weightTrend) {
        return { ...base, state: 'waiting', blocker: 'trend_unavailable' };
    }
    const paceStatus = assessmentPaceStatus(
        selected.weightTrend,
        goalRateKgPerWeek,
        input.configuredDailyDeficitKcal
    );
    if (!paceStatus) {
        return { ...base, state: 'waiting', blocker: 'weight_uncertainty' };
    }

    const assessmentWindow = {
        startDate: addDateDays(input.asOfDate, -selected.windowDays),
        endDate: input.asOfDate,
        spanDays: selected.windowDays,
        confidenceLevel: 0.95
    } as const;
    if (paceStatus === 'aligned') {
        return {
            ...base,
            state: 'on_track',
            paceStatus,
            window: assessmentWindow,
            recentWeightTrendKgPerWeek: selected.weightTrend,
            targetDecision: 'no_change_recommended'
        };
    }

    if (selected.recommendation) {
        return {
            ...base,
            state: 'off_track',
            paceStatus,
            window: assessmentWindow,
            recentWeightTrendKgPerWeek: selected.weightTrend,
            targetDecision: 'change_available'
        };
    }
    if (selected.safetyFloorBlocked) {
        return {
            ...base,
            state: 'off_track',
            paceStatus,
            window: assessmentWindow,
            recentWeightTrendKgPerWeek: selected.weightTrend,
            targetDecision: 'safety_limited'
        };
    }
    if (input.ageYears < 18 || input.configuredDailyDeficitKcal <= 0) {
        return {
            ...base,
            state: 'off_track',
            paceStatus,
            window: assessmentWindow,
            recentWeightTrendKgPerWeek: selected.weightTrend,
            targetDecision: 'policy_unavailable'
        };
    }
    if (selected.dataQuality.confidentDays < CALIBRATION_MIN_INSIGHT_DAYS) {
        return {
            ...base,
            state: 'off_track',
            paceStatus,
            window: assessmentWindow,
            recentWeightTrendKgPerWeek: selected.weightTrend,
            targetDecisionBlocker: 'food_history'
        };
    }
    const adjustmentWidth = selected.targetAdjustment
        ? selected.targetAdjustment.high - selected.targetAdjustment.low
        : Number.POSITIVE_INFINITY;
    if (adjustmentWidth > MAX_ACTIONABLE_INTERVAL_WIDTH_KCAL) {
        return {
            ...base,
            state: 'off_track',
            paceStatus,
            window: assessmentWindow,
            recentWeightTrendKgPerWeek: selected.weightTrend,
            targetDecisionBlocker: 'food_uncertainty'
        };
    }
    return {
        ...base,
        state: 'off_track',
        paceStatus,
        window: assessmentWindow,
        recentWeightTrendKgPerWeek: selected.weightTrend,
        targetDecision: 'no_change_recommended'
    };
}

type CalibrationResultWithoutAssessment = Omit<CalibrationResult, 'assessment'>;

function attachAssessment(
    result: CalibrationResultWithoutAssessment,
    input: CalibrationInput,
    selected: WindowEvaluation | null,
    goalRateKgPerWeek: number
): CalibrationResult {
    return {
        ...result,
        assessment: buildCalibrationAssessment(input, selected, goalRateKgPerWeek)
    };
}

/**
 * Evaluate recent intake and weight evidence without mutating state.
 *
 * Missing or suspicious food days are represented as conservative intake ranges instead of
 * being silently discarded. The shortest window with a sufficiently narrow interval wins;
 * otherwise the longest available window powers a descriptive, non-actionable insight.
 */
export function evaluateCalibration(sourceInput: CalibrationInput): CalibrationResult {
    const period = getCalibrationPeriod(sourceInput);
    const input = period.input;
    const configuredWeeklyWeightChangeKg = round((-input.configuredDailyDeficitKcal * 7) / KCAL_PER_KILOGRAM, 3);
    const availableSpan = input.trackingPaused
        ? 0
        : Math.min(
            CALIBRATION_MAX_OBSERVATION_DAYS,
            period.startsOn
                ? (period.startsOn <= input.asOfDate ? inclusiveDateSpan(period.startsOn, input.asOfDate) : 0)
                : Math.max(
                    0,
                    ...input.foodDays.map((day) => inclusiveDateSpan(day.date, input.asOfDate)),
                    ...input.weightPoints.map((point) => Math.max(0, inclusiveDateSpan(point.date, input.asOfDate) - 1))
                )
        );

    if (availableSpan < CALIBRATION_MIN_INSIGHT_DAYS) {
        const previewDays = availableSpan > 0 ? classifyFoodDays(input, availableSpan) : [];
        const previewStart = addDateDays(input.asOfDate, -(Math.max(1, availableSpan) - 1));
        const previewWeights = input.weightPoints
            .filter((point) => point.date >= previewStart && point.date <= input.asOfDate)
            .slice()
            .sort((left, right) => left.date.localeCompare(right.date));
        const dataQuality = availableSpan > 0 ? summarizeDataQuality(previewDays, previewWeights) : emptyQuality();
        const trackingPaused = Boolean(input.trackingPaused);
        let headline = 'See how your calorie plan is working';
        let summary = 'Calibrate first estimates your average weekly weight change. With more history, it can compare that rate with your logged calories and assess whether your calorie budget may need an adjustment.';
        let nextStep = 'Your first weight-trend estimate is available after 7 well-tracked food days and weigh-ins spanning 7 days.';
        if (period.restartedAfterPause) {
            headline = trackingPaused ? 'Calibration is paused with food tracking' : 'Gathering new history after your break';
            summary = trackingPaused
                ? 'Paused days are excluded from calibration, so your break is not treated as uncertain intake.'
                : 'Paused days and history from before your break are excluded, so they are not averaged into your current weight-trend estimate.';
            nextStep = trackingPaused
                ? 'After you resume, your next weight-trend estimate will be available after 7 well-tracked food days and weigh-ins spanning 7 days.'
                : 'Your next weight-trend estimate is available after 7 well-tracked food days and weigh-ins spanning 7 days.';
        }
        return attachAssessment({
            modelVersion: CALIBRATION_MODEL_VERSION,
            asOfDate: input.asOfDate,
            weightUnit: input.weightUnit,
            status: 'not_ready',
            headline,
            summary,
            nextStep,
            historyProgress: buildHistoryProgress(dataQuality, 'pace_check', period.restartedAfterPause),
            selectedWindowDays: null,
            dataQuality,
            missingCriteria: [
                'Complete at least 7 plausible food-log days with entries across multiple meals.',
                'Record weights spanning at least 7 days so average weekly weight change can be estimated.'
            ],
            assumptions: [],
            estimates: {
                averageIntakeKcal: null,
                observedWeeklyWeightChangeKg: null,
                targetAdjustmentKcal: null,
                configuredWeeklyWeightChangeKg
            },
            recommendation: null,
            activityContext: null
        }, input, null, configuredWeeklyWeightChangeKg);
    }

    const candidateWindows = OBSERVATION_WINDOWS.filter((days) => days <= availableSpan);
    const descriptiveWindow = Math.max(CALIBRATION_MIN_INSIGHT_DAYS, ...candidateWindows, Math.min(availableSpan, 13));
    const evaluations = Array.from(new Set<number>([descriptiveWindow, ...candidateWindows]))
        .sort((left, right) => left - right)
        .map((days) => evaluateWindow(input, days));
    const selected = evaluations.find((candidate) => candidate.actionable)
        ?? evaluations.slice().sort((left, right) => right.windowDays - left.windowDays)[0];
    // A prior segment can invalidate the longest window even after new history is mature.
    // Preserve the action window when recommending; otherwise use the longest continuous trend.
    const assessmentWindow = selected.weightTrend ? selected :
        evaluations.slice().reverse().find((candidate) =>
            candidate.weightTrend !== null && candidate.windowDays <= selected.dataQuality.weightSpanDays
        ) ?? selected;
    const hasPace = selected.weeklyWeightChange !== null && selected.dataQuality.weightSpanDays >= CALIBRATION_MIN_INSIGHT_DAYS;
    const hasFoodEvidence = selected.dataQuality.confidentDays >= CALIBRATION_MIN_INSIGHT_DAYS;
    const recommendation = selected.recommendation;

    let status: CalibrationResult['status'];
    let headline: string;
    let summary: string;
    let nextStep: string | null = null;
    let historyProgress: CalibrationResult['historyProgress'] = null;
    if (!hasPace && hasFoodEvidence) {
        status = 'learning';
        const foodDayCount = selected.dataQuality.confidentDays;
        const weightCount = selected.dataQuality.weightPoints;
        const needsCurrentWeight = selected.missingCriteria.some((criterion) => criterion.includes('current weigh-in'));
        if (needsCurrentWeight) {
            headline = 'A current weigh-in is needed';
            summary = `You have ${foodDayCount} well-tracked food day${foodDayCount === 1 ? '' : 's'}, but the latest weigh-in is too old to estimate your current average weight change.`;
            nextStep = 'Record a new weigh-in to refresh the weight-trend evidence before Calibrate assesses a calorie-budget change.';
        } else {
            headline = 'More weight history is needed';
            let weightEvidence = `${weightCount} weigh-ins do not yet span enough time to establish a reliable trend`;
            if (weightCount === 0) weightEvidence = 'no weigh-ins have been recorded yet';
            if (weightCount === 1) weightEvidence = 'a single weigh-in cannot establish a reliable trend';
            summary = `You have ${foodDayCount} well-tracked food day${foodDayCount === 1 ? '' : 's'}, but ${weightEvidence}.`;
            nextStep = 'Your next weight-trend estimate is available once your weigh-ins span 7 days.';
        }
        historyProgress = buildHistoryProgress(selected.dataQuality, 'pace_check', period.restartedAfterPause);
    } else if (hasPace && !hasFoodEvidence) {
        status = 'learning';
        headline = 'More complete food history is needed';
        summary = `${capitalizeSentence(describeWeeklyTrend(selected.weeklyWeightChange?.midpoint ?? 0, input.weightUnit))}, but there are not enough complete multi-meal food logs to compare that weight-change rate with your calorie budget.`;
        nextStep = 'Your next weight-trend estimate is available after 7 well-tracked food days with entries across multiple meals.';
        historyProgress = buildHistoryProgress(selected.dataQuality, 'pace_check', period.restartedAfterPause);
    } else if (!hasPace || !hasFoodEvidence) {
        status = 'learning';
        headline = 'More consistent evidence is needed';
        summary = 'Calibrate needs both complete food logs and a weight trend to compare your weight-change rate with your calorie budget.';
        nextStep = 'Your next weight-trend estimate is available after 7 well-tracked food days and weigh-ins spanning 7 days.';
        historyProgress = buildHistoryProgress(selected.dataQuality, 'pace_check', period.restartedAfterPause);
    } else if (recommendation) {
        status = 'recommendation';
        const observedWeekly = selected.weeklyWeightChange?.midpoint ?? 0;
        const averageIntake = averageLoggedIntake(input, selected.windowDays).toLocaleString('en-US');
        const budgetDirection = recommendation.adjustmentStepKcal < 0 ? 'lower' : 'higher';
        headline = describeRecommendationPace(observedWeekly, configuredWeeklyWeightChangeKg);
        summary = `You logged about ${averageIntake} kcal per day, and ${describeWeeklyTrend(observedWeekly, input.weightUnit)} versus ${describeProjectedWeeklyTrend(configuredWeeklyWeightChangeKg, input.weightUnit)}. This suggests a ${Math.abs(recommendation.adjustmentStepKcal)} kcal ${budgetDirection} daily calorie budget could bring your weight-change rate closer to your goal.`;
    } else {
        status = 'insight';
        const weekly = selected.weeklyWeightChange?.midpoint ?? 0;
        if (selected.safetyFloorBlocked) {
            const averageIntake = averageLoggedIntake(input, selected.windowDays).toLocaleString('en-US');
            const currentTarget = Math.round(
                input.profileTdeeKcal - input.configuredDailyDeficitKcal + input.currentTargetAdjustmentKcal
            );
            const minimumTarget = minimumTargetForBmr(input.bmrKcal);
            const floorName = input.bmrKcal >= CALIBRATION_MIN_TARGET_KCAL ? "Calibrate's BMR-based limit" : "Calibrate's calorie-budget limit";
            const floorPosition = currentTarget < minimumTarget ? 'below' : 'at';
            headline = "Calibrate won't recommend a lower budget";
            summary = `You logged about ${averageIntake} kcal per day, and ${describeWeeklyTrend(weekly, input.weightUnit)} versus ${describeProjectedWeeklyTrend(configuredWeeklyWeightChangeKg, input.weightUnit)}. This pattern would normally point to a lower budget, but your current ${currentTarget.toLocaleString('en-US')} kcal daily budget is already ${floorPosition} ${floorName} of ${minimumTarget.toLocaleString('en-US')} kcal. To avoid suggesting an overly aggressive target, Calibrate won't reduce it further.`;
            nextStep = "Calibrate won't lower your current budget. Review that your food logs, weigh-ins, and profile details are complete. If you are considering a lower budget, review your plan with a qualified health professional first.";
        } else if (selected.missingCriteria.length === 0) {
            const averageIntake = averageLoggedIntake(input, selected.windowDays);
            const currentTarget = Math.round(
                input.profileTdeeKcal - input.configuredDailyDeficitKcal + input.currentTargetAdjustmentKcal
            );
            if (Math.abs(averageIntake - currentTarget) >= ACTION_THRESHOLD_KCAL) {
                const intakeDirection = averageIntake > currentTarget ? 'higher' : 'lower';
                headline = 'Your weight-change rate matches your logged intake';
                summary = `You logged about ${averageIntake.toLocaleString('en-US')} kcal per day compared with your ${currentTarget.toLocaleString('en-US')} kcal daily budget, and ${describeWeeklyTrend(weekly, input.weightUnit)}. That weight-change rate is consistent with the ${intakeDirection} logged intake, so the calorie budget estimate itself appears sound.`;
                nextStep = `To move closer to your planned weekly rate, aim to average nearer your current ${currentTarget.toLocaleString('en-US')} kcal budget and keep logging consistently.`;
            } else {
                headline = selected.windowDays < CALIBRATION_MIN_ACTIONABLE_DAYS
                    ? 'Your early weight-trend estimate is tracking as expected'
                    : 'Your progress is tracking as expected';
                summary = `${capitalizeSentence(describeWeeklyTrend(weekly, input.weightUnit))} versus ${describeProjectedWeeklyTrend(configuredWeeklyWeightChangeKg, input.weightUnit)}. The evidence shows progress is consistent with tracking expectations.`;
            }
        } else {
            const uncertainFoodDays = selected.dataQuality.missingDays
                + selected.dataQuality.incompleteDays
                + selected.dataQuality.suspiciousDays;
            const intervalWidth = selected.targetAdjustment
                ? selected.targetAdjustment.high - selected.targetAdjustment.low
                : 0;
            if (uncertainFoodDays > 0) {
                headline = 'Food-log uncertainty limits this insight';
                summary = `${capitalizeSentence(describeWeeklyTrend(weekly, input.weightUnit))}, but ${uncertainFoodDays} uncertain food day${uncertainFoodDays === 1 ? '' : 's'} ${uncertainFoodDays === 1 ? 'widens' : 'widen'} the calorie-budget estimate. Complete daily logs across multiple meals to make the comparison more reliable.`;
                nextStep = `Complete each current food day across multiple meals. Calibrate rechecks after every completed day and will show a budget suggestion once the estimate is narrow enough to support a safe change.`;
            } else if (selected.missingCriteria.some((criterion) => criterion.includes('current weigh-in'))) {
                headline = 'A current weigh-in is needed';
                summary = `${capitalizeSentence(describeWeeklyTrend(weekly, input.weightUnit))}, but the latest weigh-in is too old to safely assess a current calorie-budget change.`;
                nextStep = 'Record a new weigh-in and keep weighing regularly under similar conditions before changing your calorie budget.';
            } else if (selected.missingCriteria.some((criterion) => criterion.includes('at least 14 days'))) {
                const observedDays = Math.min(selected.windowDays, selected.dataQuality.weightSpanDays);
                const remainingDays = Math.max(0, CALIBRATION_MIN_ACTIONABLE_DAYS - observedDays);
                headline = `Your ${selected.windowDays}-day weight-trend estimate is ready`;
                summary = `Across this ${selected.windowDays}-day calibration window, ${describeWeeklyTrend(weekly, input.weightUnit)}. Keep building history before Calibrate compares this rate with your logged calories to assess a calorie-budget change.`;
                nextStep = `Keep tracking for ${remainingDays} more day${remainingDays === 1 ? '' : 's'}. After at least 14 days of food and weight history, Calibrate can assess a calorie-budget change for you to review.`;
                historyProgress = buildHistoryProgress(selected.dataQuality, 'budget_review', period.restartedAfterPause);
            } else if (selected.weeklyWeightChange && intervalWidth > MAX_ACTIONABLE_INTERVAL_WIDTH_KCAL) {
                headline = 'Weight uncertainty limits this insight';
                summary = `${capitalizeSentence(describeWeeklyTrend(weekly, input.weightUnit))}, but the plausible weekly rate could mean ${describeWeeklyRange(selected.weeklyWeightChange, input.weightUnit)}. There is not enough certainty to assess the calorie budget safely yet.`;
                nextStep = 'Keep weighing in regularly under similar conditions, such as at the same time of day, to help narrow the range before changing your calorie budget.';
            } else {
                headline = `Your ${selected.windowDays}-day weight-trend estimate is ready`;
                summary = `Across this ${selected.windowDays}-day calibration window, ${describeWeeklyTrend(weekly, input.weightUnit)}. The remaining evidence criteria explain what Calibrate still needs before assessing your calorie budget.`;
                if (selected.missingCriteria.some((criterion) => criterion.includes('at least 3 weights'))) {
                    const remainingWeights = Math.max(0, 3 - selected.dataQuality.weightPoints);
                    nextStep = `Add ${remainingWeights} more weigh-in${remainingWeights === 1 ? '' : 's'} before Calibrate can assess a calorie-budget change.`;
                    historyProgress = buildHistoryProgress(selected.dataQuality, 'budget_review', period.restartedAfterPause);
                } else if (input.ageYears < 18) {
                    nextStep = 'Calorie-budget suggestions are currently available only to adults.';
                } else {
                    nextStep = 'Keep completing food logs and weighing in regularly. Calibrate rechecks automatically as new evidence becomes available.';
                }
            }
        }
    }

    return attachAssessment({
        modelVersion: CALIBRATION_MODEL_VERSION,
        asOfDate: input.asOfDate,
        weightUnit: input.weightUnit,
        status,
        headline,
        summary,
        nextStep,
        historyProgress,
        selectedWindowDays: selected.windowDays,
        dataQuality: selected.dataQuality,
        missingCriteria: selected.missingCriteria,
        assumptions: [
            'Weight change is converted using 7,700 kcal per kilogram.',
            'Completed multi-meal days receive a small tracking allowance.',
            'Missing and suspicious days use conservative personal intake ranges and are not treated as zero or discarded.',
            ...(period.restartedAfterPause
                ? ['Paused days and all earlier evidence are excluded so calibration restarts after the latest break.']
                : [])
        ],
        estimates: {
            averageIntakeKcal: selected.averageIntake,
            observedWeeklyWeightChangeKg: selected.weeklyWeightChange,
            targetAdjustmentKcal: selected.targetAdjustment,
            configuredWeeklyWeightChangeKg
        },
        recommendation,
        activityContext: null
    }, input, assessmentWindow, configuredWeeklyWeightChangeKg);
}
