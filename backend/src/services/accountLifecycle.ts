/** @file Account data export and deletion with credential/session cleanup and explicit transactional boundaries. */

import { Prisma } from '@prisma/client';
import prisma from '../config/database';

export const ACCOUNT_EXPORT_FORMAT = 'calibrate-account-export';
export const ACCOUNT_EXPORT_VERSION = 11;

// Auth sessions, password hashes, push endpoints/tokens, and internal replay metadata are
// deliberately absent. User-visible account, tracking, and derived plan history is exported.
const ACCOUNT_EXPORT_SELECT = {
  id: true,
  email: true,
  created_at: true,
  email_verified_at: true,
  weight_unit: true,
  height_unit: true,
  timezone: true,
  language: true,
  reminder_log_weight_enabled: true,
  reminder_log_food_enabled: true,
  reminder_log_weight_minute: true,
  reminder_log_food_minute: true,
  reminder_quiet_hours_start_minute: true,
  reminder_quiet_hours_end_minute: true,
  haptics_enabled: true,
  date_of_birth: true,
  sex: true,
  height_mm: true,
  activity_level: true,
  profile_image: true,
  profile_image_mime_type: true,
  goals: {
    orderBy: [{ created_at: 'asc' as const }, { id: 'asc' as const }]
  },
  metrics: {
    orderBy: [{ date: 'asc' as const }, { id: 'asc' as const }]
  },
  food_logs: {
    orderBy: [{ local_date: 'asc' as const }, { created_at: 'asc' as const }, { id: 'asc' as const }]
  },
  food_log_days: {
    orderBy: [{ local_date: 'asc' as const }, { id: 'asc' as const }]
  },
  daily_calorie_plans: {
    orderBy: [{ local_date: 'asc' as const }, { id: 'asc' as const }]
  },
  food_tracking_pauses: {
    orderBy: [{ starts_on: 'asc' as const }, { id: 'asc' as const }]
  },
  my_foods: {
    orderBy: [{ created_at: 'asc' as const }, { id: 'asc' as const }],
    include: {
      recipe_ingredients: {
        orderBy: [{ sort_order: 'asc' as const }, { id: 'asc' as const }]
      }
    }
  },
  in_app_notifications: {
    orderBy: [{ created_at: 'asc' as const }, { id: 'asc' as const }]
  },
  activity_records: {
    orderBy: [{ local_date: 'asc' as const }, { start_time: 'asc' as const }, { id: 'asc' as const }]
  },
  activity_day_summaries: {
    orderBy: [{ local_date: 'asc' as const }, { id: 'asc' as const }]
  },
  calibration_recommendations: {
    orderBy: [{ created_at: 'asc' as const }, { id: 'asc' as const }]
  },
  calorie_plan_revisions: {
    orderBy: [{ effective_local_date: 'asc' as const }, { id: 'asc' as const }]
  },
  legal_acceptances: {
    orderBy: [{ accepted_at: 'asc' as const }, { id: 'asc' as const }]
  }
} satisfies Prisma.UserSelect;

type AccountExportRow = Prisma.UserGetPayload<{ select: typeof ACCOUNT_EXPORT_SELECT }>;

export type AccountExport = {
  format: typeof ACCOUNT_EXPORT_FORMAT;
  version: typeof ACCOUNT_EXPORT_VERSION;
  exported_at: string;
  account: {
    id: number;
    email: string;
    created_at: string;
    email_verified_at: string | null;
    weight_unit: string;
    height_unit: string;
    timezone: string;
    language: string;
    reminder_log_weight_enabled: boolean;
    reminder_log_food_enabled: boolean;
    reminder_log_weight_minute: number;
    reminder_log_food_minute: number;
    reminder_quiet_hours_start_minute: number | null;
    reminder_quiet_hours_end_minute: number | null;
    haptics_enabled: boolean;
    date_of_birth: string | null;
    sex: string | null;
    height_mm: number | null;
    activity_level: string | null;
    profile_image: { mime_type: string; data_base64: string } | null;
  };
  legal_acceptances: Array<{
    terms_version: string;
    privacy_version: string;
    accepted_at: string;
  }>;
  goals: Array<{
    id: number;
    start_weight_grams: number;
    target_weight_grams: number;
    target_date: string | null;
    daily_deficit: number;
    calorie_plan_review_status: string;
    calorie_plan_review_reason: string | null;
    created_at: string;
  }>;
  body_metrics: Array<{
    id: number;
    date: string;
    weight_grams: number;
    body_fat_percent: number | null;
  }>;
  food_logs: Array<{
    id: number;
    my_food_id: number | null;
    date: string;
    local_date: string;
    meal_period: string;
    name: string;
    calories: number;
    servings_consumed: number | null;
    serving_size_quantity_snapshot: number | null;
    serving_unit_label_snapshot: string | null;
    calories_per_serving_snapshot: number | null;
    external_source: string | null;
    external_id: string | null;
    brand_snapshot: string | null;
    locale_snapshot: string | null;
    barcode_snapshot: string | null;
    measure_label_snapshot: string | null;
    grams_per_measure_snapshot: number | null;
    measure_quantity_snapshot: number | null;
    grams_total_snapshot: number | null;
    created_at: string;
  }>;
  food_log_days: Array<{
    id: number;
    local_date: string;
    status: string;
    origin: string;
    is_complete: boolean;
    completed_at: string | null;
    comparison_target_kcal: number | null;
    comparison_maintenance_kcal: number | null;
    comparison_captured_at: string | null;
    created_at: string;
    updated_at: string;
  }>;
  daily_calorie_plans: Array<{
    local_date: string;
    timezone: string;
    observed_at: string;
    calculation_version: number;
    target_kcal: number | null;
    maintenance_kcal: number | null;
    inputs: unknown;
    timezone_conflict: boolean;
    consumed_at: string | null;
  }>;
  food_tracking_pauses: Array<{
    id: number;
    starts_on: string;
    expected_resume_on: string | null;
    resumed_on: string | null;
    started_at: string;
    resumed_at: string | null;
    materialized_through: string;
    created_at: string;
    updated_at: string;
  }>;
  my_foods: Array<{
    id: number;
    type: string;
    name: string;
    serving_size_quantity: number;
    serving_unit_label: string;
    calories_per_serving: number;
    is_pinned: boolean;
    recipe_total_calories: number | null;
    yield_servings: number | null;
    created_at: string;
    updated_at: string;
    recipe_ingredients: Array<{
      id: number;
      sort_order: number;
      source: string;
      name_snapshot: string;
      calories_total_snapshot: number;
      source_my_food_id: number | null;
      quantity_servings: number | null;
      serving_size_quantity_snapshot: number | null;
      serving_unit_label_snapshot: string | null;
      calories_per_serving_snapshot: number | null;
      external_source: string | null;
      external_id: string | null;
      brand_snapshot: string | null;
      locale_snapshot: string | null;
      barcode_snapshot: string | null;
      measure_label_snapshot: string | null;
      grams_per_measure_snapshot: number | null;
      measure_quantity_snapshot: number | null;
      grams_total_snapshot: number | null;
      created_at: string;
    }>;
  }>;
  in_app_notifications: Array<{
    id: number;
    type: string;
    local_date: string;
    title: string | null;
    body: string | null;
    action_url: string | null;
    read_at: string | null;
    dismissed_at: string | null;
    resolved_at: string | null;
    created_at: string;
    updated_at: string;
  }>;
  activity_records: Array<{
    id: number;
    record_type: string;
    external_id: string;
    data_origin: string;
    client_record_id: string | null;
    client_record_version: string | null;
    source_updated_at: string;
    start_time: string;
    end_time: string | null;
    start_zone_offset_seconds: number | null;
    end_zone_offset_seconds: number | null;
    local_date: string;
    step_count: number | null;
    energy_kcal: number | null;
    weight_grams: number | null;
    exercise_type: number | null;
    title: string | null;
    notes: string | null;
    recording_method: number | null;
    device_type: number | null;
    device_manufacturer: string | null;
    device_model: string | null;
    created_at: string;
    updated_at: string;
  }>;
  activity_day_summaries: Array<{
    id: number;
    local_date: string;
    steps: number | null;
    active_calories_kcal: number | null;
    total_calories_kcal: number | null;
    exercise_minutes: number | null;
    observed_at: string;
    created_at: string;
    updated_at: string;
  }>;
  calibration_recommendations: Array<{
    id: number;
    source_goal_id: number;
    model_version: number;
    as_of_local_date: string;
    current_target_adjustment_kcal: number;
    recommended_target_adjustment_kcal: number;
    current_target_kcal: number;
    recommended_target_kcal: number;
    status: string;
    result_snapshot: unknown;
    created_at: string;
    applied_at: string | null;
  }>;
  calorie_plan_revisions: Array<{
    id: number;
    source_goal_id: number;
    recommendation_id: number | null;
    configured_daily_deficit: number | null;
    target_adjustment_kcal: number;
    calorie_plan_review_status: string;
    calorie_plan_review_reason: string | null;
    effective_local_date: string;
    created_at: string;
  }>;
};

const toIsoDate = (value: Date): string => value.toISOString().slice(0, 10);
const toIsoDateTime = (value: Date): string => value.toISOString();

/** Build a stable, import-friendly account document without auth or delivery credentials. */
export async function exportAccountData(userId: number, now = new Date()): Promise<AccountExport | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: ACCOUNT_EXPORT_SELECT
  });
  if (!user) return null;

  return serializeAccountExport(user, now);
}

/** Serialize the versioned user-owned data export, excluding credentials and internal session/reconciliation metadata. */
export function serializeAccountExport(user: AccountExportRow, now = new Date()): AccountExport {
  const profileImage = user.profile_image && user.profile_image_mime_type
    ? {
        mime_type: user.profile_image_mime_type,
        data_base64: Buffer.from(user.profile_image).toString('base64')
      }
    : null;

  return {
    format: ACCOUNT_EXPORT_FORMAT,
    version: ACCOUNT_EXPORT_VERSION,
    exported_at: toIsoDateTime(now),
    account: {
      id: user.id,
      email: user.email,
      created_at: toIsoDateTime(user.created_at),
      email_verified_at: user.email_verified_at ? toIsoDateTime(user.email_verified_at) : null,
      weight_unit: user.weight_unit,
      height_unit: user.height_unit,
      timezone: user.timezone,
      language: user.language,
      reminder_log_weight_enabled: user.reminder_log_weight_enabled,
      reminder_log_food_enabled: user.reminder_log_food_enabled,
      reminder_log_weight_minute: user.reminder_log_weight_minute,
      reminder_log_food_minute: user.reminder_log_food_minute,
      reminder_quiet_hours_start_minute: user.reminder_quiet_hours_start_minute,
      reminder_quiet_hours_end_minute: user.reminder_quiet_hours_end_minute,
      haptics_enabled: user.haptics_enabled,
      date_of_birth: user.date_of_birth ? toIsoDate(user.date_of_birth) : null,
      sex: user.sex,
      height_mm: user.height_mm,
      activity_level: user.activity_level,
      profile_image: profileImage
    },
    legal_acceptances: user.legal_acceptances.map((acceptance) => ({
      terms_version: acceptance.terms_version,
      privacy_version: acceptance.privacy_version,
      accepted_at: toIsoDateTime(acceptance.accepted_at)
    })),
    goals: user.goals.map((goal) => ({
      id: goal.id,
      start_weight_grams: goal.start_weight_grams,
      target_weight_grams: goal.target_weight_grams,
      target_date: goal.target_date ? toIsoDateTime(goal.target_date) : null,
      daily_deficit: goal.daily_deficit,
      calorie_plan_review_status: goal.calorie_plan_review_status,
      calorie_plan_review_reason: goal.calorie_plan_review_reason,
      created_at: toIsoDateTime(goal.created_at)
    })),
    body_metrics: user.metrics.map((metric) => ({
      id: metric.id,
      date: toIsoDate(metric.date),
      weight_grams: metric.weight_grams,
      body_fat_percent: metric.body_fat_percent
    })),
    food_logs: user.food_logs.map((log) => ({
      id: log.id,
      my_food_id: log.my_food_id,
      date: toIsoDateTime(log.date),
      local_date: toIsoDate(log.local_date),
      meal_period: log.meal_period,
      name: log.name,
      calories: log.calories,
      servings_consumed: log.servings_consumed,
      serving_size_quantity_snapshot: log.serving_size_quantity_snapshot,
      serving_unit_label_snapshot: log.serving_unit_label_snapshot,
      calories_per_serving_snapshot: log.calories_per_serving_snapshot,
      external_source: log.external_source,
      external_id: log.external_id,
      brand_snapshot: log.brand_snapshot,
      locale_snapshot: log.locale_snapshot,
      barcode_snapshot: log.barcode_snapshot,
      measure_label_snapshot: log.measure_label_snapshot,
      grams_per_measure_snapshot: log.grams_per_measure_snapshot,
      measure_quantity_snapshot: log.measure_quantity_snapshot,
      grams_total_snapshot: log.grams_total_snapshot,
      created_at: toIsoDateTime(log.created_at)
    })),
    food_log_days: user.food_log_days.map((day) => {
      const legacyDay = day as typeof day & { is_complete?: boolean };
      const status = day.status ?? (legacyDay.is_complete ? 'COMPLETE' : 'OPEN');
      return {
      id: day.id,
      local_date: toIsoDate(day.local_date),
      status,
      origin: day.origin ?? 'USER',
      is_complete: status === 'COMPLETE',
      completed_at: day.completed_at ? toIsoDateTime(day.completed_at) : null,
      comparison_target_kcal: day.comparison_target_kcal ?? null,
      comparison_maintenance_kcal: day.comparison_maintenance_kcal ?? null,
      comparison_captured_at: day.comparison_captured_at ? toIsoDateTime(day.comparison_captured_at) : null,
      created_at: toIsoDateTime(day.created_at),
      updated_at: toIsoDateTime(day.updated_at)
    };
    }),
    daily_calorie_plans: user.daily_calorie_plans.map((plan) => ({
      local_date: toIsoDate(plan.local_date), timezone: plan.timezone,
      observed_at: toIsoDateTime(plan.observed_at), calculation_version: plan.calculation_version,
      target_kcal: plan.target_kcal, maintenance_kcal: plan.maintenance_kcal,
      inputs: plan.inputs, timezone_conflict: plan.timezone_conflict,
      consumed_at: plan.consumed_at ? toIsoDateTime(plan.consumed_at) : null
    })),
    food_tracking_pauses: (user.food_tracking_pauses ?? []).map((pause) => ({
      id: pause.id,
      starts_on: toIsoDate(pause.starts_on),
      expected_resume_on: pause.expected_resume_on ? toIsoDate(pause.expected_resume_on) : null,
      resumed_on: pause.resumed_on ? toIsoDate(pause.resumed_on) : null,
      started_at: toIsoDateTime(pause.started_at),
      resumed_at: pause.resumed_at ? toIsoDateTime(pause.resumed_at) : null,
      materialized_through: toIsoDate(pause.materialized_through),
      created_at: toIsoDateTime(pause.created_at),
      updated_at: toIsoDateTime(pause.updated_at)
    })),
    my_foods: user.my_foods.map((food) => ({
      id: food.id,
      type: food.type,
      name: food.name,
      serving_size_quantity: food.serving_size_quantity,
      serving_unit_label: food.serving_unit_label,
      calories_per_serving: food.calories_per_serving,
      is_pinned: food.is_pinned,
      recipe_total_calories: food.recipe_total_calories,
      yield_servings: food.yield_servings,
      created_at: toIsoDateTime(food.created_at),
      updated_at: toIsoDateTime(food.updated_at),
      recipe_ingredients: food.recipe_ingredients.map((ingredient) => ({
        id: ingredient.id,
        sort_order: ingredient.sort_order,
        source: ingredient.source,
        name_snapshot: ingredient.name_snapshot,
        calories_total_snapshot: ingredient.calories_total_snapshot,
        source_my_food_id: ingredient.source_my_food_id,
        quantity_servings: ingredient.quantity_servings,
        serving_size_quantity_snapshot: ingredient.serving_size_quantity_snapshot,
        serving_unit_label_snapshot: ingredient.serving_unit_label_snapshot,
        calories_per_serving_snapshot: ingredient.calories_per_serving_snapshot,
        external_source: ingredient.external_source,
        external_id: ingredient.external_id,
        brand_snapshot: ingredient.brand_snapshot,
        locale_snapshot: ingredient.locale_snapshot,
        barcode_snapshot: ingredient.barcode_snapshot,
        measure_label_snapshot: ingredient.measure_label_snapshot,
        grams_per_measure_snapshot: ingredient.grams_per_measure_snapshot,
        measure_quantity_snapshot: ingredient.measure_quantity_snapshot,
        grams_total_snapshot: ingredient.grams_total_snapshot,
        created_at: toIsoDateTime(ingredient.created_at)
      }))
    })),
    in_app_notifications: user.in_app_notifications.map((notification) => ({
      id: notification.id,
      type: notification.type,
      local_date: toIsoDate(notification.local_date),
      title: notification.title,
      body: notification.body,
      action_url: notification.action_url,
      read_at: notification.read_at ? toIsoDateTime(notification.read_at) : null,
      dismissed_at: notification.dismissed_at ? toIsoDateTime(notification.dismissed_at) : null,
      resolved_at: notification.resolved_at ? toIsoDateTime(notification.resolved_at) : null,
      created_at: toIsoDateTime(notification.created_at),
      updated_at: toIsoDateTime(notification.updated_at)
    })),
    // Export user-visible Health Connect provenance, but omit device ids, tokens, and tombstones.
    activity_records: user.activity_records.map((record) => ({
      id: record.id,
      record_type: record.record_type,
      external_id: record.external_id,
      data_origin: record.data_origin,
      client_record_id: record.client_record_id,
      client_record_version: record.client_record_version?.toString() ?? null,
      source_updated_at: toIsoDateTime(record.source_updated_at),
      start_time: toIsoDateTime(record.start_time),
      end_time: record.end_time ? toIsoDateTime(record.end_time) : null,
      start_zone_offset_seconds: record.start_zone_offset_seconds,
      end_zone_offset_seconds: record.end_zone_offset_seconds,
      local_date: toIsoDate(record.local_date),
      step_count: record.step_count,
      energy_kcal: record.energy_kcal,
      weight_grams: record.weight_grams,
      exercise_type: record.exercise_type,
      title: record.title,
      notes: record.notes,
      recording_method: record.recording_method,
      device_type: record.device_type,
      device_manufacturer: record.device_manufacturer,
      device_model: record.device_model,
      created_at: toIsoDateTime(record.created_at),
      updated_at: toIsoDateTime(record.updated_at)
    })),
    activity_day_summaries: user.activity_day_summaries.map((summary) => ({
      id: summary.id,
      local_date: toIsoDate(summary.local_date),
      steps: summary.steps,
      active_calories_kcal: summary.active_calories_kcal,
      total_calories_kcal: summary.total_calories_kcal,
      exercise_minutes: summary.exercise_minutes,
      observed_at: toIsoDateTime(summary.observed_at),
      created_at: toIsoDateTime(summary.created_at),
      updated_at: toIsoDateTime(summary.updated_at)
    })),
    calibration_recommendations: user.calibration_recommendations.map((recommendation) => ({
      id: recommendation.id,
      source_goal_id: recommendation.source_goal_id,
      model_version: recommendation.model_version,
      as_of_local_date: toIsoDate(recommendation.as_of_local_date),
      current_target_adjustment_kcal: recommendation.current_target_adjustment_kcal,
      recommended_target_adjustment_kcal: recommendation.recommended_target_adjustment_kcal,
      current_target_kcal: recommendation.current_target_kcal,
      recommended_target_kcal: recommendation.recommended_target_kcal,
      status: recommendation.status,
      result_snapshot: recommendation.result_snapshot,
      created_at: toIsoDateTime(recommendation.created_at),
      applied_at: recommendation.applied_at ? toIsoDateTime(recommendation.applied_at) : null
    })),
    calorie_plan_revisions: user.calorie_plan_revisions.map((revision) => ({
      id: revision.id,
      source_goal_id: revision.source_goal_id,
      recommendation_id: revision.recommendation_id,
      configured_daily_deficit: revision.configured_daily_deficit ?? null,
      target_adjustment_kcal: revision.target_adjustment_kcal,
      calorie_plan_review_status: revision.calorie_plan_review_status,
      calorie_plan_review_reason: revision.calorie_plan_review_reason,
      effective_local_date: toIsoDate(revision.effective_local_date),
      created_at: toIsoDateTime(revision.created_at)
    }))
  };
}

/** Delete the account root; database cascades revoke sessions and remove owned records atomically. */
export async function deleteAccountData(userId: number): Promise<boolean> {
  const result = await prisma.user.deleteMany({ where: { id: userId } });
  return result.count > 0;
}
