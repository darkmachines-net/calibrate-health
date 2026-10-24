/** @file Shared public API request/response types and compatibility shapes layered over the generated wire schema. */

import type {
    ActivityLevel,
    ActivityRecordType,
    ClientDiagnosticInput as SharedClientDiagnosticInput,
    ClientDiagnosticResponse as SharedClientDiagnosticResponse,
    HeightUnit,
    MealPeriod,
    MobileDevicePlatform,
    NativePushPlatform,
    NativePushProvider,
    Sex,
    WeightUnit
} from '@calibrate/shared';

export type ClientDiagnosticInput = SharedClientDiagnosticInput;
export type ClientDiagnosticResponse = SharedClientDiagnosticResponse;

import type {
    CaloriePlanOption as SharedCaloriePlanOption,
    CaloriePlanReasonCode as SharedCaloriePlanReasonCode,
    CaloriePlanStatus as SharedCaloriePlanStatus,
    EligibilityStatus as SharedEligibilityStatus
} from '@calibrate/shared/caloriePolicy';
import type { CalibrationResult } from '@calibrate/shared/calibration';
import type { InAppNotificationType } from '@calibrate/shared/inAppNotifications';

export type EligibilityStatus = SharedEligibilityStatus;
export type CaloriePlanStatus = SharedCaloriePlanStatus;
export type CaloriePlanReasonCode = SharedCaloriePlanReasonCode;
export type CaloriePlanOption = SharedCaloriePlanOption;

export type CalorieEligibility = {
    status: EligibilityStatus;
    reasonCode: CaloriePlanReasonCode | null;
    ageYears: number | null;
    localDate: string | null;
};

export type CaloriePlanOptionsRequest = {
    timezone: string;
    date_of_birth: string | null;
    sex: Sex | null;
    activity_level: ActivityLevel | null;
    height:
        | { unit: 'CM'; centimeters: number }
        | { unit: 'FT_IN'; feet: number; inches: number };
    weight: { unit: WeightUnit; value: number };
};

export type CaloriePlanOptionsResponse = {
    eligibility: CalorieEligibility;
    bmr: number | null;
    tdee: number | null;
    minimumDailyCalorieTarget: number | null;
    planOptions: CaloriePlanOption[];
};

export type AccountAccessState =
    | 'full'
    | 'email_verification_required'
    | 'legal_acceptance_required';

export type AccountAccess = {
    state: AccountAccessState;
    email_verified: boolean;
    legal_current: boolean;
};

export type LegalDocumentVersions = {
    terms_version: string;
    privacy_version: string;
};

export type LegalAcceptanceStatus = {
    account_access: AccountAccess;
    required: LegalDocumentVersions;
    accepted: {
        terms_version: string | null;
        privacy_version: string | null;
        accepted_at: string | null;
    };
};

export type RegistrationLegalAcceptance = LegalDocumentVersions & {
    accept_terms: true;
    accept_privacy: true;
};

export type LegalAcceptanceRequest = RegistrationLegalAcceptance;

export type UserClientPayload = {
    id: number;
    email: string;
    created_at: string;
    weight_unit: WeightUnit;
    height_unit: HeightUnit;
    timezone: string;
    language: string;
    reminder_log_weight_enabled: boolean;
    reminder_log_food_enabled: boolean;
    /** Absent only on legacy self-hosts that predate reminder scheduling preferences. */
    reminder_log_weight_time?: string;
    reminder_log_food_time?: string;
    reminder_quiet_hours_start?: string | null;
    reminder_quiet_hours_end?: string | null;
    haptics_enabled: boolean;
    date_of_birth: string | null;
    sex: Sex | null;
    height_mm: number | null;
    activity_level: ActivityLevel | null;
    profile_image_url: string | null;
    /** Absent only when connected to a legacy self-host that predates atomic onboarding. */
    onboarding_completed_at?: string | null;
    /** Absent only when connected to a legacy self-host that predates account-access gates. */
    account_access?: AccountAccess;
};

export type OnboardingCompleteData = {
    weight_unit: WeightUnit;
    height_unit: HeightUnit;
    timezone: string;
    date_of_birth: string;
    sex: Sex;
    height_mm: number;
    activity_level: ActivityLevel;
    current_weight_grams: number;
    target_weight_grams: number;
    daily_deficit: number;
};

export type OnboardingCompleteRequest = {
    data: OnboardingCompleteData;
};

export type OnboardingCompleteReceipt = {
    operation_id: string;
    completed_at: string;
    goal_id: number;
    metric_id: number;
    sync_cursor: string;
};

export type OnboardingCompleteResponse = {
    receipt: OnboardingCompleteReceipt;
    user: UserClientPayload;
};

export type AccountExport = {
    format: 'calibrate-account-export';
    version: 10;
    exported_at: string;
    account: {
        id: number;
        email: string;
        email_verified_at: string | null;
        created_at: string;
        weight_unit: WeightUnit;
        height_unit: HeightUnit;
        timezone: string;
        language: string;
        reminder_log_weight_enabled: boolean;
        reminder_log_food_enabled: boolean;
        haptics_enabled: boolean;
        date_of_birth: string | null;
        sex: Sex | null;
        height_mm: number | null;
        activity_level: ActivityLevel | null;
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
        calorie_plan_review_status: 'CLEAR' | 'REQUIRES_REVIEW';
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
        meal_period: MealPeriod;
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
        status: FoodLogDayStatus;
        origin: FoodLogDayOrigin;
        is_complete: boolean;
        completed_at: string | null;
        comparison_target_kcal?: number | null;
        comparison_maintenance_kcal?: number | null;
        comparison_captured_at?: string | null;
        created_at: string;
        updated_at: string;
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
        type: 'FOOD' | 'RECIPE';
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
            source: RecipeIngredientSource;
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
        type: InAppNotificationType;
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
        record_type: ActivityRecordType;
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
        status: 'PENDING' | 'APPLIED' | 'STALE';
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
        calorie_plan_review_status: 'CLEAR' | 'REQUIRES_REVIEW';
        calorie_plan_review_reason: string | null;
        effective_local_date: string;
        created_at: string;
    }>;
};

export type DeleteAccountRequest = {
    current_password: string;
};

export type MobileAuthRequest = {
    email: string;
    password: string;
    device_id: string;
    device_platform?: 'android_phone' | 'ios';
    device_name?: string;
};

export type MobileRegistrationRequest = MobileAuthRequest & Partial<RegistrationLegalAcceptance>;

export type BrowserAuthRequest = {
    email: string;
    password: string;
};

export type BrowserRegistrationRequest = BrowserAuthRequest & Partial<RegistrationLegalAcceptance>;

export type EmailVerificationResendRequest = {
    email?: string;
};

export type EmailVerificationConfirmRequest = {
    token: string;
};

export type PasswordResetRequest = {
    email: string;
};

export type PasswordResetConfirmRequest = {
    token: string;
    new_password: string;
};

export type MessageResponse = {
    message: string;
};

export type EmailVerificationConfirmResponse = MessageResponse & {
    account_access: AccountAccess;
};

export type BrowserAuthResponse = {
    user: UserClientPayload;
};

export type MobileAuthResponse = {
    user: UserClientPayload;
    access_token: string;
    refresh_token: string;
    access_expires_at: string;
    refresh_expires_at: string;
};

export type WearAuthPrincipal = Pick<
    UserClientPayload,
    'id' | 'timezone' | 'language' | 'weight_unit' | 'height_unit'
>;

export type WearMobileAuthResponse = Omit<MobileAuthResponse, 'user'> & {
    user: WearAuthPrincipal;
};

export type MobileRefreshResponse = MobileAuthResponse | WearMobileAuthResponse;

export type MobileSessionSummary = {
    id: number;
    device_id: string;
    device_platform: MobileDevicePlatform;
    device_name: string | null;
    created_at: string;
    last_used_at: string | null;
    refresh_expires_at: string;
    current: boolean;
};

export type AccountSessionSummary = {
    id: string;
    kind: 'browser' | 'android_phone' | 'ios' | 'wear_os';
    device_label: string | null;
    created_at: string;
    last_activity_at: string | null;
    current: boolean;
};

export type ConnectedAppSummary = {
    id: string;
    client_id: string;
    client_name: string;
    scopes: string[];
    resource: string;
    created_at: string;
    last_used_at: string | null;
    expires_at: string;
};

export type WearPairingCredentialRequest = {
    server_origin: string;
    watch_device_id: string;
    watch_device_name?: string;
    protocol_version: 1;
    watch_public_key_spki: string;
};

export type WearPairingCredentialResponse = {
    pairing_token: string;
    server_origin: string;
    watch_device_id: string;
    protocol_version: 1;
    challenge: string;
    expires_at: string;
};

export type WearPairingExchangeRequest = {
    pairing_token: string;
    server_origin: string;
    watch_device_id: string;
    protocol_version: 1;
    exchange_id: string;
    challenge_signature: string;
};

export type WatchQuickAddDraft = {
    id: string;
    source: 'pinned' | 'recent';
    label: string;
    calories: number;
    draft: FoodLogCreatePayload;
};

export type WatchFoodDaySnapshot = {
    status: FoodLogDayStatus;
    source: FoodLogDayOrigin | null;
    is_representative: boolean;
    is_complete: boolean;
    completed_at: string | null;
    revision: string | null;
};

export type WatchFoodDayMutation = Omit<WatchFoodDaySnapshot, 'revision'> & {
    date: string;
    revision: string;
};

export type WatchSnapshot = {
    server_time: string;
    timezone: string;
    local_date: string;
    weight_unit: 'KG' | 'LB';
    revision: string;
    plan?: {
        status: CaloriePlanStatus;
        reason_code: CaloriePlanReasonCode | null;
        minimum_daily_calorie_target: number | null;
    };
    calories: {
        consumed: number;
        target: number | null;
        remaining: number | null;
        missing: string[];
    };
    food_day: WatchFoodDaySnapshot;
    weight: {
        today_grams: number | null;
        today_revision: string | null;
        latest_grams: number | null;
        latest_revision: string | null;
        latest_date: string | null;
    };
    goal?: {
        start_weight_grams: number;
        target_weight_grams: number;
        current_weight_grams: number | null;
        daily_deficit: number;
        progress_percent: number | null;
        remaining_weight_grams: number;
        is_complete: boolean;
        projection?: {
            status: 'projected' | 'maintenance' | 'reached' | 'unavailable';
            projected_end_date: string | null;
            reason_code: CaloriePlanReasonCode | null;
        };
    } | null;
    quick_add: WatchQuickAddDraft[];
    reminders: Array<{
        id: number;
        type: 'food' | 'weight';
        local_date: string;
        created_at: string;
    }>;
    undo_candidate: { food_log_id: number; name: string; calories: number; created_at: string } | null;
};

export type WatchSnapshotFetchResult = {
    body: WatchSnapshot | null;
    etag: string | null;
    notModified: boolean;
};

export type WatchMutationRequest =
    | { type: 'food.create'; payload: FoodLogCreatePayload }
    | { type: 'food.delete'; payload: { food_log_id: number } }
    | { type: 'metric.upsert'; payload: { local_date: string; weight_grams: number; expected_revision: string | null } }
    | { type: 'food_day.set_complete'; payload: { local_date: string; is_complete: boolean; expected_revision: string | null } };

export type WatchFoodLog = FoodLogEntry & {
    date: string;
    local_date: string;
    created_at: string;
};

export type WatchMutationResponse =
    | { type: 'food.create'; food_log: WatchFoodLog }
    | { type: 'food.delete'; food_log_id: number; deleted: true }
    | { type: 'metric.upsert'; metric: { id: number; local_date: string; weight_grams: number; revision: string } }
    | { type: 'food_day.set_complete'; food_day: WatchFoodDayMutation };

export type ServerFeatures = {
    nutrition_label_scanning: boolean;
};

export type ServerSettingsResponse = {
    features: ServerFeatures;
    is_admin: boolean;
};

export type ClientConfigResponse = {
    api_version: number;
    api_versions: {
        current: 'v1';
        supported: string[];
        legacy_alias: string;
        legacy_deprecation: string;
    };
    server_version: string;
    hosted_origin: string;
    min_supported_mobile_version: string;
    min_supported_wear_version: string;
    capabilities: {
        self_hosted_server_url: boolean;
        native_push: boolean;
        /** Optional for compatibility with servers released before browser capability discovery. */
        web_push?: boolean;
        health_connect_activity: boolean;
        wear_os_ready: boolean;
    };
};

type HealthConnectRecordBase = {
    record_id: string;
    data_origin: string;
    client_record_id?: string | null;
    client_record_version?: string | null;
    source_updated_at: string;
    start_time: string;
    end_time?: string | null;
    start_zone_offset_seconds?: number | null;
    end_zone_offset_seconds?: number | null;
    title?: string | null;
    notes?: string | null;
    recording_method?: number | null;
    device_type?: number | null;
    device_manufacturer?: string | null;
    device_model?: string | null;
};

export type HealthConnectStepUpsert = HealthConnectRecordBase & { count: number };
export type HealthConnectEnergyUpsert = HealthConnectRecordBase & { energy_kcal: number };
export type HealthConnectWeightUpsert = HealthConnectRecordBase & { weight_grams: number };
export type HealthConnectExerciseUpsert = HealthConnectRecordBase & { exercise_type: number };
export type HealthConnectRecordUpsert =
    | HealthConnectStepUpsert
    | HealthConnectEnergyUpsert
    | HealthConnectWeightUpsert
    | HealthConnectExerciseUpsert;

type ActivityDaySummaryBase = {
    local_date: string;
    steps?: number | null;
    active_calories_kcal?: number | null;
    total_calories_kcal?: number | null;
    exercise_minutes?: number | null;
    observed_at: string;
};

export type ActivityDaySummaryPayload = ActivityDaySummaryBase & (
    | { steps: number }
    | { active_calories_kcal: number }
    | { total_calories_kcal: number }
    | { exercise_minutes: number }
);

type HealthConnectSyncBase = {
    next_changes_token: string;
    deleted_record_ids?: string[];
    day_summaries?: ActivityDaySummaryPayload[];
};

export type HealthConnectReplaceWindow = {
    start_date: string;
    end_date: string;
};

export type HealthConnectSyncPayload =
    | (HealthConnectSyncBase & { sync_mode: 'incremental'; replace_window?: never; record_type: 'STEPS'; previous_changes_token: string | null; upserts?: HealthConnectStepUpsert[] })
    | (HealthConnectSyncBase & { sync_mode: 'incremental'; replace_window?: never; record_type: 'ACTIVE_CALORIES' | 'TOTAL_CALORIES'; previous_changes_token: string | null; upserts?: HealthConnectEnergyUpsert[] })
    | (HealthConnectSyncBase & { sync_mode: 'incremental'; replace_window?: never; record_type: 'EXERCISE_SESSION'; previous_changes_token: string | null; upserts?: HealthConnectExerciseUpsert[] })
    | (HealthConnectSyncBase & { sync_mode: 'incremental'; replace_window?: never; record_type: 'WEIGHT'; previous_changes_token: string | null; upserts?: HealthConnectWeightUpsert[] })
    | (HealthConnectSyncBase & { sync_mode: 'reset'; replace_window?: HealthConnectReplaceWindow; record_type: 'STEPS'; previous_changes_token: null; upserts?: HealthConnectStepUpsert[] })
    | (HealthConnectSyncBase & { sync_mode: 'reset'; replace_window?: HealthConnectReplaceWindow; record_type: 'ACTIVE_CALORIES' | 'TOTAL_CALORIES'; previous_changes_token: null; upserts?: HealthConnectEnergyUpsert[] })
    | (HealthConnectSyncBase & { sync_mode: 'reset'; replace_window?: HealthConnectReplaceWindow; record_type: 'EXERCISE_SESSION'; previous_changes_token: null; upserts?: HealthConnectExerciseUpsert[] })
    | (HealthConnectSyncBase & { sync_mode: 'reset'; replace_window?: HealthConnectReplaceWindow; record_type: 'WEIGHT'; previous_changes_token: null; upserts?: HealthConnectWeightUpsert[] });

export type HealthConnectSyncResponse = {
    record_type: ActivityRecordType;
    upserted: number;
    deleted: number;
    reset_deleted: number;
    stale_ignored: number;
    tombstoned_ignored: number;
    day_summaries_upserted: number;
    day_summaries_stale_ignored: number;
    checkpoint_advanced: true;
};

export type ActivityRecordEntry = {
    id: number;
    record_type: ActivityRecordType;
    record_id: string;
    data_origin: string;
    client_record_id: string | null;
    client_record_version: string | null;
    source_updated_at: string;
    start_time: string;
    end_time: string | null;
    start_zone_offset_seconds: number | null;
    end_zone_offset_seconds: number | null;
    local_date: string;
    count: number | null;
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
};

export type ActivityDaySummary = {
    id: number;
    local_date: string;
    steps: number | null;
    active_calories_kcal: number | null;
    total_calories_kcal: number | null;
    exercise_minutes: number | null;
    observed_at: string;
    created_at: string;
    updated_at: string;
};

export type ActivityDaysResponse = {
    start_date: string;
    end_date: string;
    days: Array<{
        local_date: string;
        summary: ActivityDaySummary | null;
        records: ActivityRecordEntry[];
    }>;
};

export type UserProfile = {
    timezone: string;
    date_of_birth: string | null;
    sex: Sex | null;
    height_mm: number | null;
    activity_level: ActivityLevel | null;
    weight_unit: WeightUnit;
    height_unit: HeightUnit;
};

export type CalorieSummary = {
    baseDailyCalorieTarget?: number;
    dailyCalorieTarget?: number;
    tdee?: number;
    bmr?: number;
    deficit?: number | null;
    targetAdjustment?: number;
    sourceWeightKg?: number;
    missing: string[];
    eligibility?: CalorieEligibility;
    planStatus?: CaloriePlanStatus;
    planReasonCode?: CaloriePlanReasonCode | null;
    planOptions?: CaloriePlanOption[];
    minimumDailyCalorieTarget?: number | null;
};

export type UserProfileResponse = {
    profile: UserProfile;
    latest_weight_grams: number | null;
    goal_daily_deficit: number | null;
    calorie_target_adjustment: number;
    calorieSummary: CalorieSummary;
};

export type ScheduledCalibrationChange = {
    recommendationId: number | null;
    targetAdjustmentKcal: number;
    dailyCalorieBudgetKcal: number | null;
    effectiveLocalDate: string;
};

export type CalibrationStatusResponse = {
    generatedAt: string;
    inputFingerprint: string | null;
    evaluation: CalibrationResult;
    recommendation: {
        id: number;
        status: 'pending';
        inputFingerprint: string;
        effectiveLocalDate: string;
    } | null;
    scheduledChange: ScheduledCalibrationChange | null;
    planStatus?: CaloriePlanStatus;
    planReasonCode?: CaloriePlanReasonCode | null;
};

export type GoalPaceRequest = { daily_deficit: number; expected_plan_version: string };
export type GoalPaceOptions = CaloriePlanOptionsResponse & {
    goal: GoalEntry;
    expected_plan_version: string;
    effective_local_date: string;
};

export type GoalEntry = {
    id: number;
    user_id?: number;
    start_weight: number;
    target_weight: number;
    target_date: string | null;
    daily_deficit: number;
    created_at: string;
    calorie_plan_review_status?: 'CLEAR' | 'REQUIRES_REVIEW';
    calorie_plan_review_reason?: string | null;
    plan_status?: CaloriePlanStatus;
    plan_reason_code?: CaloriePlanReasonCode | null;
    projection?: {
        status: 'projected' | 'maintenance' | 'reached' | 'unavailable';
        projected_end_date: string | null;
        reason_code: CaloriePlanReasonCode | null;
    };
};

export type MetricEntry = {
    id: number;
    date: string;
    weight: number;
};

export type MetricSaveKind = 'created' | 'updated' | 'unchanged';

export type MetricProgressRecognition =
    | { type: 'goal_reached' }
    | { type: 'goal_percent'; threshold_percent: 25 | 50 | 75 }
    | { type: 'goal_weight'; threshold_grams: number }
    | { type: 'meaningful_best'; improvement_grams: number }
    | { type: 'baseline_recorded' };

export type MetricGoalProgressUpdate = {
    id: number;
    mode: 'lose' | 'gain' | 'maintain';
    previous_progress_percent: number | null;
    current_progress_percent: number | null;
    remaining_weight_grams: number;
    is_complete: boolean;
    reached_local_date: string | null;
};

export type MetricProgressUpdate = {
    save_kind: MetricSaveKind;
    local_date: string;
    is_current_day: boolean;
    current_weight_grams: number;
    goal: MetricGoalProgressUpdate | null;
    recognitions: MetricProgressRecognition[];
};

/** New servers attach a transactional progress receipt; older servers return only MetricEntry. */
export type MetricSaveResponse = MetricEntry & {
    progress_update?: MetricProgressUpdate;
};

export type FoodLogEntry = {
    id: number;
    meal_period: MealPeriod;
    name: string;
    calories: number;
    my_food_id?: number | null;
    servings_consumed?: number | null;
    serving_size_quantity_snapshot?: number | null;
    serving_unit_label_snapshot?: string | null;
    calories_per_serving_snapshot?: number | null;
    external_source?: string | null;
    external_id?: string | null;
    brand_snapshot?: string | null;
    locale_snapshot?: string | null;
    barcode_snapshot?: string | null;
    measure_label_snapshot?: string | null;
    grams_per_measure_snapshot?: number | null;
    measure_quantity_snapshot?: number | null;
    grams_total_snapshot?: number | null;
};

export type FoodLogCopyMealMapping = {
    source_meal_period: MealPeriod;
    target_meal_period: MealPeriod;
};

export type FoodLogCopyPayload = {
    operation_id: string;
    source_date: string;
    target_date: string;
    meal_mappings?: FoodLogCopyMealMapping[];
};

export type FoodLogCopyResponse = {
    operation_id: string;
    source_date: string;
    target_date: string;
    copied_count: number;
    food_logs: FoodLogEntry[];
};

export type FoodLogCreatePayload = {
    date: string;
    meal_period: MealPeriod;
    name?: string;
    calories?: number;
    my_food_id?: number | null;
    servings_consumed?: number | null;
    serving_size_quantity_snapshot?: number | null;
    serving_unit_label_snapshot?: string | null;
    calories_per_serving_snapshot?: number | null;
    external_source?: string | null;
    external_id?: string | null;
    brand?: string | null;
    locale?: string | null;
    barcode?: string | null;
    measure_label?: string | null;
    grams_per_measure_snapshot?: number | null;
    measure_quantity_snapshot?: number | null;
    grams_total_snapshot?: number | null;
};

export type FoodLogUpdatePayload = Partial<{
    name: string;
    calories: number;
    meal_period: MealPeriod;
    servings_consumed: number | null;
}>;

export type FoodSearchNutrients = {
    calories: number;
    protein?: number;
    fat?: number;
    carbs?: number;
};

export type FoodSearchMeasure = {
    label: string;
    gramWeight?: number;
    quantity?: number;
    unit?: string;
};

export type FoodSearchResult = {
    id: string;
    source: string;
    description: string;
    brand?: string;
    barcode?: string;
    locale?: string;
    availableMeasures: FoodSearchMeasure[];
    nutrientsPer100g?: FoodSearchNutrients;
    nutrientsForRequest?: {
        grams: number;
        nutrients: FoodSearchNutrients;
        note?: string;
    };
};

export type FoodSearchResponse = {
    items: FoodSearchResult[];
    provider?: string;
    supportsBarcodeLookup?: boolean;
    attribution?: string;
};

export type FoodLogDayStatus = 'OPEN' | 'COMPLETE' | 'INCOMPLETE' | 'PAUSED';
export type FoodLogDayOrigin = 'USER' | 'PAUSE' | 'IMPORT';
export type FoodLogDaySource =
    | 'STORED'
    | 'ACTIVE_PAUSE'
    | 'INFERRED_EMPTY'
    | 'DEFAULT'
    | 'BEFORE_TRACKING_START';

export type FoodDayCalorieComparison = {
    consumed_kcal: number;
    target_kcal: number;
    maintenance_kcal: number;
    captured_at: string;
};

export type FoodLogDay = {
    /** Optional for older servers; null means no trustworthy historical comparison. */
    calorie_comparison?: FoodDayCalorieComparison | null;
    date: string;
    status: FoodLogDayStatus;
    origin: FoodLogDayOrigin | null;
    source: FoodLogDaySource;
    is_representative: boolean;
    is_complete: boolean;
    completed_at: string | null;
    updated_at?: string | null;
};

export type FoodLogDayRange = {
    start_date: string;
    end_date: string;
    days: FoodLogDay[];
};

export type FoodTrackingPause = {
    active: boolean;
    id: number | null;
    starts_on: string | null;
    expected_resume_on: string | null;
    resumed_on: string | null;
    started_at: string | null;
    resumed_at: string | null;
    materialized_through: string | null;
    resume_confirmation_due: boolean;
};

export type InAppNotification = {
    id: number;
    type: InAppNotificationType;
    local_date: string;
    title: string | null;
    body: string | null;
    action_url: string;
    read_at: string | null;
    dismissed_at: string | null;
    created_at: string;
};

export type InAppNotificationsResponse = {
    notifications: InAppNotification[];
    unread_count: number;
};

export type InAppNotificationView = 'active' | 'history';

export type InAppNotificationsQuery = {
    view: InAppNotificationView;
    limit?: number;
    cursor?: string;
};

export type InAppNotificationPageItem = InAppNotification & {
    resolved_at: string | null;
    updated_at: string;
};

export type InAppNotificationPageResponse = {
    notifications: InAppNotificationPageItem[];
    unread_count: number;
    next_cursor: string | null;
};

export type MarkAllInAppNotificationsReadResponse = {
    ok: true;
    updated_count: number;
};

export type NativePushSubscriptionPayload = {
    token: string;
    device_id?: string;
    platform?: NativePushPlatform;
    provider?: NativePushProvider;
};

export type BrowserPushSubscriptionPayload = {
    endpoint: string;
    expirationTime?: number | null;
    keys: {
        p256dh: string;
        auth: string;
    };
};

export type RecentFoodSummary = {
    id: string;
    name: string;
    meal_period: MealPeriod;
    calories: number;
    my_food_id: number | null;
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
    last_logged_at: string;
    times_logged: number;
};

export type RecentFoodsResponse = {
    items: RecentFoodSummary[];
};

export type RecentFoodsQuery = {
    q?: string;
    limit?: number;
    meal_period?: MealPeriod;
};

export type MyFoodType = 'FOOD' | 'RECIPE';

export type MyFoodSummary = {
    id: number;
    type: MyFoodType;
    name: string;
    serving_size_quantity: number;
    serving_unit_label: string;
    calories_per_serving: number;
    is_pinned: boolean;
    recipe_total_calories?: number | null;
    yield_servings?: number | null;
};

export type MyFoodsLibraryQuery = {
    q?: string;
    type?: MyFoodType;
    cursor?: string;
    limit?: number;
};

export type MyFoodsLibraryResponse = {
    items: MyFoodSummary[];
    next_cursor: string | null;
};

export type RecipeIngredientSource = 'MY_FOOD' | 'EXTERNAL';

export type RecipeIngredientSummary = {
    id: number;
    recipe_id: number;
    sort_order: number;
    source: RecipeIngredientSource;
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
};

export type MyFoodDetail = MyFoodSummary & {
    recipe_ingredients?: RecipeIngredientSummary[];
};

export type NutritionLabelDraft = {
    calories_per_serving: number | null;
    serving_size_quantity: number | null;
    serving_unit_label: string | null;
    serving_text: string | null;
    warnings: string[];
};

export type CreateMyFoodPayload = {
    name: string;
    serving_size_quantity: number;
    serving_unit_label: string;
    calories_per_serving: number;
};

export type CreateRecipePayload = {
    name: string;
    serving_size_quantity: number;
    serving_unit_label: string;
    yield_servings: number;
    ingredients: Array<
        | {
              source: 'MY_FOOD';
              sort_order?: number;
              my_food_id: number;
              quantity_servings: number;
          }
        | {
              source: 'EXTERNAL';
              sort_order?: number;
              name: string;
              calories_total: number;
              external_source?: string | null;
              external_id?: string | null;
              brand?: string | null;
              locale?: string | null;
              barcode?: string | null;
              quantity_servings?: number | null;
              serving_size_quantity?: number | null;
              serving_unit_label?: string | null;
              calories_per_serving?: number | null;
              measure_label?: string | null;
              grams_per_measure?: number | null;
              measure_quantity?: number | null;
              grams_total?: number | null;
          }
    >;
};

export type CreateRecipeFromFoodLogsPayload = {
    name: string;
    yield_servings: number;
    food_log_ids: number[];
};

export type UpdateMyFoodPayload = CreateMyFoodPayload | CreateRecipePayload;

export type TrendMetricEntry = MetricEntry & {
    user_id: number;
    body_fat_percent: number | null;
    trend_is_materialized?: boolean;
    trend_segment_start?: boolean;
    trend_weight: number;
    trend_ci_lower: number;
    trend_ci_upper: number;
    trend_std: number;
};

export type WeightTrendSummaryStatus = 'insufficient' | 'provisional' | 'sufficient' | 'stale' | 'unavailable';

export type WeightTrendRateEvidence = 'insufficient' | 'provisional' | 'sufficient';

export type WeightTrendFreshness = 'current' | 'stale' | 'outdated' | 'unavailable';

export type WeightTrendWeeklyRate = {
    estimate: number;
    /** Posterior standard deviation of the local velocity state, scaled to the display unit per week. */
    std?: number;
    lower: number;
    upper: number;
    point_count: number;
    span_days: number;
    evidence: WeightTrendRateEvidence;
    /** Additive interval semantics; older v2 servers omit it. */
    interval_kind?: 'local_velocity_state_model_uncertainty';
};

export type WeightTrendSummary = {
    /** Legacy v2 field retained while evidence and freshness roll out independently. */
    status?: WeightTrendSummaryStatus;
    evidence?: WeightTrendRateEvidence;
    freshness?: WeightTrendFreshness;
    model_version: number | null;
    as_of_date: string;
    scope_start_date: string | null;
    scope_end_date: string | null;
    latest_observation_date: string | null;
    days_since_latest: number | null;
    /** Start of the active modeled window; older returned points are measurement-only context. */
    modeled_start_date?: string | null;
    /** Number of points returned for the requested scope, including measurement-only context. */
    returned_points?: number;
    /** Source observations in the coherent bounded model pass; absent on older servers. */
    modeled_observations?: number;
    /** Modeled points present in the returned scope; absent on older servers. */
    returned_modeled_points?: number;
    /** Legacy alias of returned_modeled_points. */
    modeled_points: number;
    observation_span_days: number;
    segment_start_date: string | null;
    interval_kind?: 'latent_weight_model_uncertainty';
    confidence_level?: 0.95;
    latest_trend: {
        weight: number;
        lower: number;
        upper: number;
    } | null;
    weekly_rate: WeightTrendWeeklyRate | null;
    short_term_variation: {
        standard_deviation: number;
        central_80_half_width: number;
    } | null;
};

export type TrendMetricsResponse = {
    metrics: TrendMetricEntry[];
    meta: {
        weekly_rate: number;
        volatility: 'low' | 'medium' | 'high';
        total_points: number;
        total_span_days: number;
        /** Additive v2 summary. Older servers omit it. */
        trend_summary?: WeightTrendSummary;
    };
};

export type LoseItImportSummary = {
    food_logs: {
        total: number;
        valid: number;
        invalid: number;
    };
    weights: {
        total: number;
        valid: number;
        invalid: number;
    };
    warnings: string[];
    foodDayCompletionStatus?: 'unavailable';
    foodDayCompletionMessage?: string;
};

export type SyncChange = {
    cursor: string;
    entity_type: string;
    entity_id: string;
    action: 'upsert' | 'delete';
    operation_id: string | null;
    payload: unknown;
    created_at: string;
};

export type SyncChangesResponse = {
    changes: SyncChange[];
    next_cursor: string;
    has_more: boolean;
};
