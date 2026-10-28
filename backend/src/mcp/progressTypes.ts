/** @file Pure JSON contracts shared by MCP analysis tools and the isolated progress App. No server runtime dependencies. */

export type ProgressRangeInput = { start_date?: string; end_date?: string };
export type ProgressRange = { start_date: string; end_date: string; day_count: number };
export type ProgressSections = { food: boolean; weight: boolean };
export type ProgressHistory = { first_date: string | null; last_date: string | null };
type ProgressCaloriePlan = {
  as_of_date: string | null;
  plan_status: string;
  plan_reason_code: string | null;
  profile_estimated_tdee_kcal: number | null;
  base_daily_target_kcal: number | null;
  current_daily_target_kcal: number | null;
  target_adjustment_kcal: number | null;
  configured_daily_deficit_kcal: number | null;
};
export type ProgressGoal = {
  direction: 'weight_loss' | 'weight_gain' | 'maintenance';
  start_weight: number;
  target_weight: number;
  current_weight: number | null;
  current_weight_date: string | null;
  weight_unit: 'kg' | 'lb';
  progress_percent: number | null;
  remaining_weight: number;
  configured_daily_deficit_kcal: number;
  projection_status: 'projected' | 'maintenance' | 'reached' | 'unavailable';
  projected_end_date: string | null;
};
export type ProgressFoodDay = {
  date: string;
  status: 'OPEN' | 'COMPLETE' | 'INCOMPLETE' | 'PAUSED';
  source: string;
  is_representative: boolean;
  total_calories_kcal: number;
  entry_count: number;
  calorie_comparison: { consumed_kcal: number; target_kcal: number; maintenance_kcal: number; captured_at: string } | null;
};
export type ProgressFoodGroup = {
  key: string;
  complete_day_count: number;
  total_calories_kcal: number;
  average_daily_calories_kcal: number | null;
};
type ProgressFoodSummary = {
  complete_day_count: number;
  open_day_count: number;
  incomplete_day_count: number;
  paused_day_count: number;
  before_tracking_day_count: number;
  total_calories_kcal: number;
  average_daily_calories_kcal: number | null;
  compared_day_count: number;
  compared_consumed_total_kcal: number;
  compared_target_total_kcal: number;
  average_captured_target_kcal: number | null;
  average_target_difference_kcal: number | null;
};
export type ProgressFood = {
  days: ProgressFoodDay[];
  summary: ProgressFoodSummary;
  patterns: { weekdays: ProgressFoodGroup[]; week_parts: ProgressFoodGroup[]; meal_periods: ProgressFoodGroup[] };
};
export type ProgressWeightPoint = {
  date: string;
  raw_weight: number;
  trend_weight: number | null;
  confidence_95: { lower: number; upper: number } | null;
  is_segment_start: boolean | null;
};
type ProgressWeightSummary = {
  observation_count: number;
  first_observation: { date: string; weight: number } | null;
  last_observation: { date: string; weight: number } | null;
  observation_span_days: number;
  raw_weight_change: number | null;
};
export type ProgressWeight = {
  weight_unit: 'kg' | 'lb';
  points: ProgressWeightPoint[];
  period_summary: ProgressWeightSummary;
  trend: {
    as_of_date: string;
    status: string;
    evidence_status: string;
    freshness: string;
    model_version: number;
    latest_observation_date: string | null;
    days_since_latest_observation: number | null;
    latest_trend: { weight: number; lower: number; upper: number } | null;
    weekly_rate: { estimate: number; lower: number; upper: number; unit: 'kg/week' | 'lb/week'; status: string; point_count: number; span_days: number } | null;
  };
};
export type ProgressExplorerSnapshot = {
  schema_version: 1;
  as_of_date: string;
  timezone: string;
  range: ProgressRange;
  granted_sections: ProgressSections;
  available_history: { food: ProgressHistory | null; weight: ProgressHistory | null };
  current_goal: ProgressGoal | null;
  current_calorie_plan: ProgressCaloriePlan;
  food: ProgressFood | null;
  weight: ProgressWeight | null;
  interpretation_notes: string[];
};
export type ProgressPeriodSummary = {
  range: ProgressRange;
  food: Omit<ProgressFood, 'days'> | null;
  weight: Omit<ProgressWeight, 'points'> | null;
};
export type ProgressComparisonSnapshot = {
  schema_version: 1;
  as_of_date: string;
  timezone: string;
  granted_sections: ProgressSections;
  current_goal: ProgressGoal | null;
  current_calorie_plan: ProgressCaloriePlan;
  first: ProgressPeriodSummary;
  second: ProgressPeriodSummary;
  differences: { average_daily_calories_kcal: number | null; average_target_difference_kcal: number | null; raw_weight_change: number | null };
  interpretation_notes: string[];
};
