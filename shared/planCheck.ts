/** @file Descriptive plan-check and weekly-report wire contracts; these never authorize calorie-plan changes. */

export const PLAN_CHECK_WINDOWS = [7, 14, 28] as const;

export type PlanCheckWindow = {
    days: 7 | 14 | 28;
    startDate: string;
    endDate: string;
    loggedFoodDays: number;
    completeFoodDays: number;
    averageLoggedCalories: number | null;
    weighIns: number;
    weightSpanDays: number;
    weightChangeKg: number | null;
    weeklyWeightChangeKg: number | null;
};

export type PlanCheckSummary = {
    localDate: string;
    trackingSince: string | null;
    trackingDays: number;
    weightUnit: 'KG' | 'LB';
    latestWeighInDate: string | null;
    needsWeighIn: boolean;
    windows: PlanCheckWindow[];
};

export type WeeklyProgressReport = {
    reportDate: string;
    generatedAt: string;
    summary: string;
    highlights: string[];
    nextStep: string;
};

export type PlanCheckResponse = PlanCheckSummary & {
    weeklyReportsEnabled: boolean;
    weeklyReports: WeeklyProgressReport[];
};
