/** @file Deterministic synthetic weight/intake histories for calibration lab presets and model validation. */

import type { CalibrationFoodDay, CalibrationInput, CalibrationWeightPoint } from './calibration';

export type CalibrationScenario = {
    id: string;
    name: string;
    description: string;
    input: CalibrationInput;
    previewState?: 'scheduled';
};

const AS_OF_DATE = '2026-07-31';

function addDays(date: string, delta: number): string {
    const parsed = new Date(`${date}T00:00:00.000Z`);
    parsed.setUTCDate(parsed.getUTCDate() + delta);
    return parsed.toISOString().slice(0, 10);
}

function buildFoodDays(options: {
    days: number;
    calories: number;
    missingEvery?: number;
    suspiciousEvery?: number;
    calorieDrift?: number;
}): CalibrationFoodDay[] {
    const result: CalibrationFoodDay[] = [];
    for (let offset = -(options.days - 1); offset <= 0; offset += 1) {
        const index = offset + options.days;
        if (options.missingEvery && index % options.missingEvery === 0) continue;
        const suspicious = Boolean(options.suspiciousEvery && index % options.suspiciousEvery === 0);
        result.push({
            date: addDays(AS_OF_DATE, offset),
            calories: Math.round(options.calories + (options.calorieDrift ?? 0) * index),
            entryCount: suspicious ? 1 : 5,
            mealPeriodCount: suspicious ? 1 : 3,
            isComplete: true
        });
    }
    return result;
}

function buildWeights(days: number, startWeightKg: number, weeklyChangeKg: number, measurementNoiseKg = 0.06): CalibrationWeightPoint[] {
    const points: CalibrationWeightPoint[] = [];
    for (let offset = -(days - 1); offset <= 0; offset += 2) {
        const elapsed = offset + days - 1;
        const trendWeightKg = startWeightKg + (weeklyChangeKg * elapsed) / 7;
        points.push({
            date: addDays(AS_OF_DATE, offset),
            weightKg: trendWeightKg + measurementNoiseKg * Math.sin((elapsed / Math.max(1, days - 1)) * Math.PI * 4)
        });
    }
    if (points[points.length - 1]?.date !== AS_OF_DATE) {
        const trendWeightKg = startWeightKg + (weeklyChangeKg * (days - 1)) / 7;
        points.push({
            date: AS_OF_DATE,
            weightKg: trendWeightKg
        });
    }
    return points;
}

const baseInput = {
    asOfDate: AS_OF_DATE,
    weightUnit: 'KG',
    ageYears: 38,
    bmrKcal: 1650,
    profileTdeeKcal: 2400,
    configuredDailyDeficitKcal: 500,
    currentTargetAdjustmentKcal: 0
} as const;

export const CALIBRATION_SCENARIOS: CalibrationScenario[] = [
    {
        id: 'not-ready',
        name: 'Waiting - short history',
        description: 'A short history sets expectations without showing provisional pace or calorie metrics.',
        input: {
            ...baseInput,
            foodDays: buildFoodDays({ days: 6, calories: 1900 }),
            weightPoints: buildWeights(6, 90, -0.45)
        }
    },
    {
        id: 'after-pause',
        name: 'Gathering history after a break',
        description: 'A tracking pause resets the evidence window and shows fresh progress instead of uncertain intake.',
        input: {
            ...baseInput,
            foodDays: buildFoodDays({ days: 28, calories: 1900 }).map((day) => ({
                ...day,
                isComplete: day.date > '2026-07-28',
                isPaused: day.date >= '2026-07-18' && day.date <= '2026-07-28'
            })),
            weightPoints: buildWeights(28, 90, -0.23)
        }
    },
    {
        id: 'learning-weights',
        name: 'Learning - insufficient weights',
        description: 'Food tracking is strong, but a single weight cannot establish a reliable pace.',
        input: {
            ...baseInput,
            foodDays: buildFoodDays({ days: 14, calories: 1900 }),
            weightPoints: buildWeights(14, 90, -0.23).slice(0, 1)
        }
    },
    {
        id: 'early-insight',
        name: 'Waiting - under two weeks',
        description: 'A one-week trend remains hidden until the weight history can support a reliable conclusion.',
        input: {
            ...baseInput,
            foodDays: buildFoodDays({ days: 7, calories: 1900 }),
            // Seven elapsed days require an eight-date window; seven food days are still sufficient.
            weightPoints: buildWeights(8, 90, -0.45)
        }
    },
    {
        id: 'on-track',
        name: 'On-track complete history',
        description: 'The current calorie budget and observed weight pace agree.',
        input: {
            ...baseInput,
            foodDays: buildFoodDays({ days: 28, calories: 1900 }),
            weightPoints: buildWeights(28, 90, -0.455)
        }
    },
    {
        id: 'maintenance',
        name: 'Maintenance goal',
        description: 'A maintenance goal receives the same measured comparisons without calorie-target actions.',
        input: {
            ...baseInput,
            configuredDailyDeficitKcal: 0,
            foodDays: buildFoodDays({ days: 28, calories: 2400 }),
            weightPoints: buildWeights(28, 90, 0)
        }
    },
    {
        id: 'gain',
        name: 'Weight-gain goal',
        description: 'A gain goal receives an honest goal-relative check without automatic target adjustments.',
        input: {
            ...baseInput,
            configuredDailyDeficitKcal: -500,
            foodDays: buildFoodDays({ days: 28, calories: 2900 }),
            weightPoints: buildWeights(28, 90, 0.3)
        }
    },
    {
        id: 'on-track-pounds',
        name: 'On-track history in pounds',
        description: 'The same reassuring on-track conclusion is presented entirely in the user\'s pounds preference.',
        input: {
            ...baseInput,
            weightUnit: 'LB',
            foodDays: buildFoodDays({ days: 28, calories: 1900 }),
            weightPoints: buildWeights(28, 90, -0.455)
        }
    },
    {
        id: 'target-too-high',
        name: 'Weight loss slower than goal',
        description: 'Weight is falling more slowly than the configured goal despite consistent logs, so a lower calorie budget may help.',
        input: {
            ...baseInput,
            foodDays: buildFoodDays({ days: 28, calories: 1900 }),
            weightPoints: buildWeights(28, 90, -0.23)
        }
    },
    {
        id: 'scheduled',
        name: 'Scheduled target adjustment',
        description: 'A scheduled target update stays visible alongside the underlying off-track assessment.',
        previewState: 'scheduled',
        input: {
            ...baseInput,
            foodDays: buildFoodDays({ days: 28, calories: 1900 }),
            weightPoints: buildWeights(28, 90, -0.23)
        }
    },
    {
        id: 'target-too-low',
        name: 'Weight loss faster than goal',
        description: 'Weight is falling faster than the configured goal with consistent logs, so a higher calorie budget may help.',
        input: {
            ...baseInput,
            foodDays: buildFoodDays({ days: 28, calories: 1900 }),
            weightPoints: buildWeights(28, 90, -0.75)
        }
    },
    {
        id: 'prior-adjustment-rollback',
        name: 'Previous budget decrease is reversed',
        description: 'New evidence shows the reduced budget is now too low, so returning to the prior 1,900 kcal budget may help.',
        input: {
            ...baseInput,
            currentTargetAdjustmentKcal: -150,
            foodDays: buildFoodDays({ days: 28, calories: 1750 }),
            weightPoints: buildWeights(28, 90, -0.59)
        }
    },
    {
        id: 'adherence-not-target',
        name: 'Pace explained by intake',
        description: 'Higher logged intake explains the slower loss, so the calorie budget estimate itself does not need adjustment.',
        input: {
            ...baseInput,
            foodDays: buildFoodDays({ days: 28, calories: 2200 }),
            weightPoints: buildWeights(28, 90, -0.18)
        }
    },
    {
        id: 'missing-and-suspicious',
        name: 'Missing and suspicious days',
        description: 'Skipped days and one-entry completed days widen uncertainty instead of disappearing.',
        input: {
            ...baseInput,
            foodDays: buildFoodDays({ days: 28, calories: 1900, missingEvery: 4, suspiciousEvery: 5 }),
            weightPoints: buildWeights(28, 90, -0.2)
        }
    },
    {
        id: 'wide-weight-uncertainty',
        name: 'Wide weight uncertainty',
        description: 'A slow trend points downward, but broad weight intervals prevent a safe recommendation.',
        input: {
            ...baseInput,
            foodDays: buildFoodDays({ days: 28, calories: 1900 }),
            weightPoints: buildWeights(28, 90, -0.23, 0.9)
        }
    },
    {
        id: 'activity-context',
        name: 'Activity input is ignored',
        description: 'Activity does not change the calorie estimate and is not surfaced in an otherwise on-track review.',
        input: {
            ...baseInput,
            foodDays: buildFoodDays({ days: 28, calories: 1900 }),
            weightPoints: buildWeights(28, 90, -0.455),
            activityDays: buildFoodDays({ days: 28, calories: 1900 }).map((day, index) => ({
                date: day.date,
                steps: 8000 + index * 10,
                activeCaloriesKcal: 350 + index
            }))
        }
    },
    {
        id: 'bmr-floor',
        name: 'Decrease capped by BMR-based limit',
        description: "Evidence supports a larger decrease, but the suggested budget stops at Calibrate's 1,900 kcal BMR-based limit.",
        input: {
            ...baseInput,
            bmrKcal: 1900,
            profileTdeeKcal: 2250,
            configuredDailyDeficitKcal: 250,
            currentTargetAdjustmentKcal: 0,
            foodDays: buildFoodDays({ days: 28, calories: 2000 }),
            weightPoints: buildWeights(28, 90, 0.05)
        }
    },
    {
        id: 'bmr-floor-blocked',
        name: 'Decrease blocked by BMR-based limit',
        description: "Evidence supports a lower budget, but the current calorie budget is already below Calibrate's BMR-based limit.",
        input: {
            ...baseInput,
            bmrKcal: 1850,
            profileTdeeKcal: 2250,
            configuredDailyDeficitKcal: 500,
            foodDays: buildFoodDays({ days: 28, calories: 1750 }),
            weightPoints: buildWeights(28, 90, 0.05)
        }
    },
    {
        id: 'maximum-window',
        name: 'History capped at 42 days',
        description: 'Ninety days of on-track data confirm that evaluation remains bounded to the latest 42 days.',
        input: {
            ...baseInput,
            foodDays: buildFoodDays({ days: 90, calories: 1900 }),
            weightPoints: buildWeights(90, 90, -0.455)
        }
    }
];

/** Find a deterministic lab preset by its stable ID, returning undefined for an unknown scenario. */
export function getCalibrationScenario(id: string): CalibrationScenario | undefined {
    return CALIBRATION_SCENARIOS.find((scenario) => scenario.id === id);
}
