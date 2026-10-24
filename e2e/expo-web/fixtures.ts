/** @file fixtures: Keep unrelated late PWA lifecycle notices from intercepting feature-test actions. */

import {
  expect,
  test as base,
  type BrowserContext,
  type Page,
  type Route,
  type TestInfo,
} from '@playwright/test';

export const FROZEN_NOW = '2026-07-21T19:00:00.000Z';
export const FROZEN_LOCAL_DATE = '2026-07-21';
export const DETERMINISTIC_CLOCK_STEP_MS = 16;

const TRANSIENT_PWA_TITLES = [
  'Back online',
  'Update ready',
  'Update failed',
  'Updating Calibrate',
] as const;

/** Keep unrelated late PWA lifecycle notices from intercepting feature-test actions. */
export async function hideTransientPwaNotices(page: Page) {
  await page.evaluate((titles) => {
    const testWindow = window as typeof window & {
      __calibrateTransientPwaObserver?: MutationObserver;
    };
    const hideKnownNotices = () => {
      for (const notice of document.querySelectorAll<HTMLElement>('[role="status"], [role="alert"]')) {
        const text = notice.textContent ?? '';
        if (titles.some((title) => text.includes(title))) notice.style.display = 'none';
      }
    };
    testWindow.__calibrateTransientPwaObserver?.disconnect();
    hideKnownNotices();
    const observer = new MutationObserver(hideKnownNotices);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    testWindow.__calibrateTransientPwaObserver = observer;
  }, [...TRANSIENT_PWA_TITLES]);
}

export const UX_FIXTURE_STATES = [
  'signed-out',
  'populated',
  'empty',
  'paused',
  'loading',
  'failed-request',
  'stale',
  'offline',
] as const;

export type UxFixtureState = (typeof UX_FIXTURE_STATES)[number];
type CaloriePlanFixtureState =
  | 'available'
  | 'requires-review'
  | 'selected-options-unavailable';

export const API_RESOURCE_FIXTURE_STATES = [
  'content',
  'empty',
  'loading',
  'error',
  'stale',
  'offline',
] as const;

export type ApiResourceFixtureState = (typeof API_RESOURCE_FIXTURE_STATES)[number];

export type ApiResourceFixture = {
  pathname: string;
  state: ApiResourceFixtureState;
  content: unknown | ((url: URL) => unknown);
  empty: unknown | ((url: URL) => unknown);
  method?: string;
  /** Match a query-bearing resource without coupling the fixture to parameter order. */
  matches?: (url: URL) => boolean;
};

type StubMetricEntry = { id: number; date: string; weight: number };

type StubMealPeriod =
  | 'BREAKFAST'
  | 'MORNING_SNACK'
  | 'LUNCH'
  | 'AFTERNOON_SNACK'
  | 'DINNER'
  | 'EVENING_SNACK';

type StubFoodEntry = {
  id: number;
  meal_period: StubMealPeriod;
  name: string;
  calories: number;
  servings_consumed?: number | null;
  [key: string]: unknown;
};

type StubTrendMetricEntry = StubMetricEntry & {
  user_id: number;
  body_fat_percent: number | null;
  trend_weight: number;
  trend_ci_lower: number;
  trend_ci_upper: number;
};

export type AuthenticatedApiOptions = {
  caloriePlanFixture?: CaloriePlanFixtureState;
  foodDayStatus?: 'OPEN' | 'COMPLETE' | 'INCOMPLETE' | 'PAUSED';
  foodEntries?: StubFoodEntry[];
  foodEntriesByDate?: Record<string, StubFoodEntry[]>;
  metrics?: StubMetricEntry[];
  trendMetrics?: StubTrendMetricEntry[];
  trendAvailability?: 'available' | 'unavailable';
  apiResources?: readonly ApiResourceFixture[];
};

type FixtureDiagnostics = {
  browserErrors: string[];
  unexpectedApiRequests: string[];
  lastFailedRequest: string | null;
  expectedApiFailures: Set<string>;
  expectedResourceErrors: Map<number, number>;
  resourceErrors: Map<number, number>;
};

export type ExpectedApiFailure = {
  method: string;
  pathname: string;
  status: number;
};

export type UxStateController = {
  /** Switches the fixture transport into offline behavior for connectivity scenarios. */
  activateOffline(): Promise<void>;
  /** Releases responses held by the fixture's loading state. */
  releaseLoading(): void;
};

export type UxHarness = {
  /** Installs the requested synthetic authenticated state and returns its transition controls. */
  install(state: UxFixtureState, options?: AuthenticatedApiOptions): Promise<UxStateController>;
  /** Installs this fixture on the supplied page and returns its transition controls. */
  installOnPage(page: Page): Promise<UxStateController>;
};

const AUTHENTICATED_USER = {
  id: 17,
  email: 'release@example.invalid',
  created_at: '2026-01-01T12:00:00.000Z',
  weight_unit: 'KG',
  height_unit: 'CM',
  timezone: 'America/Los_Angeles',
  language: 'en',
  reminder_log_weight_enabled: true,
  reminder_log_food_enabled: true,
  haptics_enabled: true,
  date_of_birth: '1985-05-12',
  sex: 'MALE',
  height_mm: 1800,
  activity_level: 'LIGHT',
  profile_image_url: null,
};

const PROFILE_RESPONSE = {
  profile: {
    timezone: AUTHENTICATED_USER.timezone,
    date_of_birth: AUTHENTICATED_USER.date_of_birth,
    sex: AUTHENTICATED_USER.sex,
    height_mm: AUTHENTICATED_USER.height_mm,
    activity_level: AUTHENTICATED_USER.activity_level,
    weight_unit: AUTHENTICATED_USER.weight_unit,
    height_unit: AUTHENTICATED_USER.height_unit,
  },
  latest_weight_grams: 88_200,
  goal_daily_deficit: 500,
  calorieSummary: {
    dailyCalorieTarget: 2_100,
    tdee: 2_600,
    bmr: 2_000,
    deficit: 500,
    missing: [],
    eligibility: {
      status: 'eligible',
      reasonCode: null,
      ageYears: 41,
      localDate: FROZEN_LOCAL_DATE,
    },
    planStatus: 'available',
    planReasonCode: null,
    minimumDailyCalorieTarget: 2_000,
  },
};

const TREND_METRICS: StubTrendMetricEntry[] = [
  { id: 3, user_id: 17, date: '2026-07-18', weight: 88.2, body_fat_percent: null, trend_weight: 88.4, trend_ci_lower: 88.0, trend_ci_upper: 88.8 },
  { id: 2, user_id: 17, date: '2026-07-11', weight: 89.0, body_fat_percent: null, trend_weight: 89.1, trend_ci_lower: 88.7, trend_ci_upper: 89.5 },
  { id: 1, user_id: 17, date: '2026-07-04', weight: 90.0, body_fat_percent: null, trend_weight: 89.8, trend_ci_lower: 89.4, trend_ci_upper: 90.2 },
];

const DEFAULT_FOOD_ENTRIES: NonNullable<AuthenticatedApiOptions['foodEntries']> = [{
  id: 31,
  meal_period: 'BREAKFAST',
  name: 'Fixture breakfast',
  calories: 360,
  servings_consumed: 1,
}];

const DEFAULT_GOAL = {
  id: 7,
  start_weight: 90,
  target_weight: 82,
  target_date: null,
  daily_deficit: 500,
  created_at: '2026-07-01T12:00:00.000Z',
  plan_status: 'available',
  plan_reason_code: null,
  projection: {
    status: 'projected',
    projected_end_date: '2026-11-20',
    reason_code: null,
  },
};

const AVAILABLE_PLAN_OPTIONS = [-1000, -750, -500, -250, 0, 250, 500, 750, 1000].map((dailyDeficit) => {
  const dailyCalorieTarget = 2_600 - dailyDeficit;
  const available = dailyCalorieTarget >= 2_000;
  return {
    dailyDeficit,
    available,
    dailyCalorieTarget: available ? dailyCalorieTarget : null,
    reasonCode: available ? null : 'TARGET_BELOW_MINIMUM',
  };
});

function getCaloriePlanFixture(state: CaloriePlanFixtureState) {
  if (state === 'requires-review') {
    const reasonCode = 'HISTORICAL_PLAN_REQUIRES_REVIEW';
    return {
      profile: {
        ...PROFILE_RESPONSE,
        calorieSummary: {
          ...PROFILE_RESPONSE.calorieSummary,
          dailyCalorieTarget: undefined,
          missing: ['calorie_plan'],
          planStatus: 'requires_review',
          planReasonCode: reasonCode,
        },
      },
      goal: {
        ...DEFAULT_GOAL,
        plan_status: 'requires_review',
        plan_reason_code: reasonCode,
        projection: { status: 'unavailable', projected_end_date: null, reason_code: reasonCode },
      },
      options: {
        eligibility: PROFILE_RESPONSE.calorieSummary.eligibility,
        bmr: 2_000,
        tdee: 2_600,
        minimumDailyCalorieTarget: 2_000,
        planOptions: AVAILABLE_PLAN_OPTIONS,
      },
    };
  }
  if (state === 'selected-options-unavailable') {
    return {
      profile: {
        ...PROFILE_RESPONSE,
        goal_daily_deficit: null,
        calorieSummary: {
          ...PROFILE_RESPONSE.calorieSummary,
          dailyCalorieTarget: undefined,
          deficit: null,
          missing: ['goal'],
          planStatus: 'unavailable',
          planReasonCode: 'GOAL_REQUIRED',
        },
      },
      goal: null,
      options: {
        eligibility: PROFILE_RESPONSE.calorieSummary.eligibility,
        bmr: 2_000,
        tdee: 2_600,
        minimumDailyCalorieTarget: 2_000,
        planOptions: AVAILABLE_PLAN_OPTIONS.map((option) => option.dailyDeficit === 500
          ? {
              ...option,
              available: false,
              dailyCalorieTarget: null,
              reasonCode: 'TARGET_BELOW_MINIMUM',
            }
          : option),
      },
    };
  }
  return {
    profile: PROFILE_RESPONSE,
    goal: DEFAULT_GOAL,
    options: {
      eligibility: PROFILE_RESPONSE.calorieSummary.eligibility,
      bmr: 2_000,
      tdee: 2_600,
      minimumDailyCalorieTarget: 2_000,
      planOptions: AVAILABLE_PLAN_OPTIONS,
    },
  };
}

const CALIBRATION_STATUS_RESPONSE = {
  generatedAt: '2026-07-18T12:00:00.000Z',
  inputFingerprint: null,
  evaluation: {
    modelVersion: 2,
    asOfDate: '2026-07-18',
    weightUnit: 'KG',
    status: 'not_ready',
    headline: 'See how your calorie plan is working',
    summary: 'Keep logging food and weight to build your first pace check.',
    nextStep: 'Keep following your current plan and log consistently.',
    historyProgress: {
      stage: 'pace_check',
      observedDays: 6,
      requiredDays: 7,
      completeFoodDays: 6,
      requiredCompleteFoodDays: 7,
      weightSpanDays: 6,
      requiredWeightSpanDays: 7,
      weightPoints: 6,
      requiredWeightPoints: 2,
      restartedAfterPause: false,
    },
    selectedWindowDays: null,
    dataQuality: {
      observationDays: 6,
      completeDays: 6,
      confidentDays: 6,
      suspiciousDays: 0,
      incompleteDays: 0,
      missingDays: 0,
      weightPoints: 6,
      weightSpanDays: 6,
    },
    missingCriteria: ['Build at least 7 days of food and weight history.'],
    assumptions: [],
    estimates: {
      averageIntakeKcal: null,
      observedWeeklyWeightChangeKg: null,
      targetAdjustmentKcal: null,
      configuredWeeklyWeightChangeKg: -0.455,
    },
    recommendation: null,
    activityContext: null,
  },
  recommendation: null,
  scheduledChange: null,
};

const diagnosticsByPage = new WeakMap<Page, FixtureDiagnostics>();
const RESOURCE_ERROR_STATUS_PATTERN = /status of (\d{3}) \(/;

function apiFailureKey({ method, pathname, status }: ExpectedApiFailure): string {
  return `${method.toUpperCase()} ${pathname} ${status}`;
}

/** Allow only the browser resource error emitted for this exact stubbed response. */
export function expectApiFailure(page: Page, failure: ExpectedApiFailure): void {
  const diagnostics = diagnosticsByPage.get(page);
  if (!diagnostics) throw new Error('Expected API failures must be declared after fixture setup.');
  diagnostics.expectedApiFailures.add(apiFailureKey(failure));
}

/** Activate browser offline mode while allowing only its exact expected resource-console diagnostic. */
export async function activateFixtureOffline(page: Page): Promise<void> {
  const diagnostics = diagnosticsByPage.get(page);
  if (!diagnostics) throw new Error('Fixture diagnostics must be installed before activating offline mode.');
  diagnostics.intentionalOffline = true;
  await page.context().setOffline(true);
}

function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

function fulfillApiError(route: Route, status: number, code: string, message: string): Promise<void> {
  const requestId = `fixture-${code.toLowerCase().replaceAll('_', '-')}`;
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'x-request-id': requestId },
    body: JSON.stringify({
      message,
      code,
      retryable: status === 408 || status === 429 || status >= 500,
      request_id: requestId,
    }),
  });
}

function resolveResourceFixtureBody(body: ApiResourceFixture['content'], url: URL): unknown {
  return typeof body === 'function' ? body(url) : body;
}

async function freezeBrowserInputs(page: Page, manualClock = false): Promise<void> {
  // Lifecycle tests need to advance timers as well as Date, before the app first mounts.
  if (manualClock) await page.clock.install({ time: new Date(FROZEN_NOW) });
  await page.addInitScript(({ frozenNow, clockStepMs, manualClock }) => {
    const NativeDate = Date;
    const frozenEpoch = NativeDate.parse(frozenNow);
    let clockReadCount = 0;
    const deterministicNow = () => {
      const now = frozenEpoch + (clockReadCount * clockStepMs);
      clockReadCount += 1;
      return now;
    };
    const DeterministicDate = new Proxy(NativeDate, {
      apply(target, thisArgument, argumentsList) {
        if (argumentsList.length > 0) return Reflect.apply(target, thisArgument, argumentsList);
        return new target(deterministicNow()).toString();
      },
      construct(target, argumentsList) {
        return Reflect.construct(target, argumentsList.length > 0 ? argumentsList : [deterministicNow()]);
      },
    });
    if (!manualClock) {
      Object.defineProperty(DeterministicDate, 'now', {
        configurable: true,
        value: deterministicNow,
      });
      globalThis.Date = DeterministicDate;
    }

    const generatedIdStorageKey = '__calibrateE2eGeneratedId';
    const storedGeneratedId = Number.parseInt(
      globalThis.sessionStorage.getItem(generatedIdStorageKey) ?? '0',
      10,
    );
    let generatedId = Number.isSafeInteger(storedGeneratedId) && storedGeneratedId >= 0 ? storedGeneratedId : 0;
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: () => {
        generatedId += 1;
        globalThis.sessionStorage.setItem(generatedIdStorageKey, generatedId.toString());
        return `00000000-0000-4000-8000-${generatedId.toString(16).padStart(12, '0')}`;
      },
    });
  }, { frozenNow: FROZEN_NOW, clockStepMs: DETERMINISTIC_CLOCK_STEP_MS, manualClock });
}

function formatFailureContext(page: Page, testInfo: TestInfo, diagnostics: FixtureDiagnostics): string {
  const viewport = page.viewportSize();
  let route = 'unavailable';
  try {
    route = new URL(page.url()).pathname;
  } catch {
    // Navigation may have failed before a URL was available.
  }
  return [
    `route=${route}`,
    `viewport=${viewport ? `${viewport.width}x${viewport.height}` : testInfo.project.name}`,
    `project=${testInfo.project.name}`,
    `last_failed_request=${diagnostics.lastFailedRequest ?? 'none'}`,
  ].join(' ');
}

async function installSignedOutApi(page: Page): Promise<void> {
  expectApiFailure(page, { method: 'GET', pathname: '/auth/me', status: 401 });
  await page.route('**/auth/me', (route) => fulfillApiError(route, 401, 'NOT_AUTHENTICATED', 'Not authenticated'));
}

async function installAuthenticatedApi(
  page: Page,
  state: Exclude<UxFixtureState, 'signed-out' | 'offline'>,
  options: AuthenticatedApiOptions,
  releaseLoading: Promise<void>,
): Promise<void> {
  const defaultFoodEntries = state === 'empty' ? [] : DEFAULT_FOOD_ENTRIES;
  const metrics = options.metrics
    ?? (state === 'empty' ? [] : TREND_METRICS.map(({ id, date, weight }) => ({ id, date, weight })));
  const trendMetrics = options.trendMetrics ?? (state === 'empty' ? [] : TREND_METRICS);
  const trendUnavailable = options.trendAvailability === 'unavailable';
  const defaultFoodDayStatus = state === 'paused' ? 'PAUSED' : 'OPEN';
  const caloriePlan = getCaloriePlanFixture(options.caloriePlanFixture ?? 'available');
  const foodRequestCounts = new Map<string, number>();
  const apiResourceRequestCounts = new Map<string, number>();
  const mutableFoodEntriesByDate = new Map(
    Object.entries(options.foodEntriesByDate ?? {}).map(([date, entries]) => [
      date,
      entries.map((entry) => ({ ...entry })),
    ]),
  );
  let nextFoodEntryId = Math.max(
    100,
    ...Array.from(mutableFoodEntriesByDate.values()).flat().map(({ id }) => id),
    ...(options.foodEntries ?? defaultFoodEntries).map(({ id }) => id),
  ) + 1;

  function getFoodEntries(date: string): StubFoodEntry[] {
    return mutableFoodEntriesByDate.get(date)
      ?? (options.foodEntries ?? defaultFoodEntries).map((entry) => ({ ...entry }));
  }

  function getMutableFoodEntries(date: string): StubFoodEntry[] {
    const current = mutableFoodEntriesByDate.get(date);
    if (current) return current;
    const entries = getFoodEntries(date);
    mutableFoodEntriesByDate.set(date, entries);
    return entries;
  }
  if (state === 'failed-request' || state === 'stale') {
    expectApiFailure(page, { method: 'GET', pathname: '/api/v1/food', status: 503 });
  }
  for (const resource of options.apiResources ?? []) {
    if (resource.state === 'error' || resource.state === 'stale') {
      expectApiFailure(page, {
        method: resource.method ?? 'GET',
        pathname: resource.pathname,
        status: 503,
      });
    }
  }

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    if (pathname === '/auth/me') return fulfillJson(route, { user: AUTHENTICATED_USER });
    if (pathname === '/api/v1/client-config') {
      return fulfillJson(route, {
        api_version: 1,
        server_version: '1.0.0',
        capabilities: {
          self_hosted_server_url: true,
          native_push: false,
          web_push: false,
          health_connect_activity: true,
          wear_os_ready: true,
        },
      });
    }
    const resourceFixture = options.apiResources?.find((resource) => (
      pathname === resource.pathname
      && route.request().method() === (resource.method ?? 'GET')
      && (resource.matches?.(url) ?? true)
    ));
    if (resourceFixture) {
      const resourceKey = `${pathname}${url.search}`;
      const requestCount = (apiResourceRequestCounts.get(resourceKey) ?? 0) + 1;
      apiResourceRequestCounts.set(resourceKey, requestCount);
      if (resourceFixture.state === 'loading') await releaseLoading;
      if (
        resourceFixture.state === 'error'
        || (resourceFixture.state === 'stale' && requestCount > 1)
      ) {
        return fulfillApiError(
          route,
          503,
          'SERVICE_UNAVAILABLE',
          'This fixture request failed with private upstream detail.',
        );
      }
      const body = resourceFixture.state === 'empty'
        ? resourceFixture.empty
        : resourceFixture.content;
      return fulfillJson(route, resolveResourceFixtureBody(body, url));
    }
    if (pathname === '/api/v1/server-settings') return fulfillJson(route, {
      // Exercise the complete existing feature surface; server-admin.spec covers the default-off state.
      is_admin: false, features: { nutrition_label_scanning: true }
    });
    if (pathname === '/api/v1/client-diagnostics' && route.request().method() === 'POST') {
      return route.fulfill({ status: 204 });
    }
    if (pathname === '/auth/sessions') return fulfillJson(route, { sessions: [] });
    if (pathname === '/auth/mobile/sessions') return fulfillJson(route, { sessions: [] });
    if (pathname === '/api/v1/legal/status') {
      return fulfillJson(route, {
        account_access: { state: 'full', email_verified: true, legal_current: true },
        required: { terms_version: '2026-08-09', privacy_version: '2026-07-24' },
        accepted: {
          terms_version: '2026-08-09',
          privacy_version: '2026-07-24',
          accepted_at: '2026-08-09T12:00:00.000Z',
        },
      });
    }
    if (pathname === '/api/v1/user/profile') return fulfillJson(route, caloriePlan.profile);
    if (pathname === '/api/v1/user/connected-apps') {
      return fulfillJson(route, { connections: [] });
    }
    if (pathname === '/api/v1/calorie-plan/options') return fulfillJson(route, caloriePlan.options);
    if (pathname === '/api/v1/notifications/in-app') {
      return fulfillJson(route, { notifications: [], unread_count: 0 });
    }
    if (pathname === '/api/v1/notifications/stream') {
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': fixture heartbeat\n\n' });
    }
    if (pathname === '/api/v1/food/recent') return fulfillJson(route, { items: [] });
    if (pathname === '/api/v1/my-foods') return fulfillJson(route, []);
    if (pathname === '/api/v1/my-foods/library') {
      return fulfillJson(route, { items: [], next_cursor: null });
    }
    if (pathname === '/api/v1/food/copy' && route.request().method() === 'POST') {
      const payload = route.request().postDataJSON() as {
        operation_id: string;
        source_date: string;
        target_date: string;
        meal_mappings?: Array<{
          source_meal_period: StubMealPeriod;
          target_meal_period: StubMealPeriod;
        }>;
      };
      const mappings = payload.meal_mappings ?? [];
      const copiedEntries = getFoodEntries(payload.source_date).flatMap((entry) => {
        if (mappings.length === 0) return [{ ...entry, id: nextFoodEntryId++ }];
        return mappings
          .filter(({ source_meal_period }) => source_meal_period === entry.meal_period)
          .map(({ target_meal_period }) => ({ ...entry, id: nextFoodEntryId++, meal_period: target_meal_period }));
      });
      getMutableFoodEntries(payload.target_date).push(...copiedEntries);
      return fulfillJson(route, {
        operation_id: payload.operation_id,
        source_date: payload.source_date,
        target_date: payload.target_date,
        copied_count: copiedEntries.length,
        food_logs: copiedEntries,
      });
    }
    if (pathname === '/api/v1/food') {
      if (route.request().method() === 'POST') {
        const payload = route.request().postDataJSON() as {
          date: string;
          meal_period: StubMealPeriod;
          name?: string;
          calories?: number;
        };
        const entry: StubFoodEntry = {
          ...payload,
          id: nextFoodEntryId++,
          name: payload.name ?? 'Quick entry',
          calories: payload.calories ?? 0,
        };
        getMutableFoodEntries(payload.date).push(entry);
        return fulfillJson(route, entry, 201);
      }
      const requestDate = url.searchParams.get('date') ?? FROZEN_LOCAL_DATE;
      const requestCount = (foodRequestCounts.get(requestDate) ?? 0) + 1;
      foodRequestCounts.set(requestDate, requestCount);
      if (state === 'loading') await releaseLoading;
      const isSelectedDate = requestDate === FROZEN_LOCAL_DATE;
      if (isSelectedDate && (state === 'failed-request' || (state === 'stale' && requestCount > 1))) {
        return fulfillApiError(
          route,
          503,
          'SERVICE_UNAVAILABLE',
          'This fixture request failed with provider details that must stay private.',
        );
      }
      return fulfillJson(route, getFoodEntries(requestDate));
    }
    const foodEntryMatch = /^\/api\/v1\/food\/(\d+)$/.exec(pathname);
    if (foodEntryMatch) {
      const entryId = Number(foodEntryMatch[1]);
      const entryCollection = Array.from(mutableFoodEntriesByDate.values())
        .find((entries) => entries.some(({ id }) => id === entryId));
      const entryIndex = entryCollection?.findIndex(({ id }) => id === entryId) ?? -1;
      if (!entryCollection || entryIndex < 0) {
        return fulfillApiError(route, 404, 'FOOD_LOG_NOT_FOUND', 'Food log not found.');
      }
      if (route.request().method() === 'PATCH') {
        const update = route.request().postDataJSON() as Partial<StubFoodEntry>;
        entryCollection[entryIndex] = { ...entryCollection[entryIndex], ...update, id: entryId };
        return fulfillJson(route, entryCollection[entryIndex]);
      }
      if (route.request().method() === 'DELETE') {
        entryCollection.splice(entryIndex, 1);
        return route.fulfill({ status: 204 });
      }
    }
    if (pathname === '/api/v1/food-days/pause') {
      const foodDayStatus = options.foodDayStatus ?? defaultFoodDayStatus;
      const isPaused = foodDayStatus === 'PAUSED';
      return fulfillJson(route, {
        pause: {
          active: isPaused,
          id: isPaused ? 9 : null,
          starts_on: isPaused ? FROZEN_LOCAL_DATE : null,
          expected_resume_on: isPaused ? '2099-12-31' : null,
          resumed_on: null,
          started_at: isPaused ? FROZEN_NOW : null,
          resumed_at: null,
          materialized_through: isPaused ? FROZEN_LOCAL_DATE : null,
          resume_confirmation_due: false,
        },
      });
    }
    if (pathname === '/api/v1/food-days/range') {
      const foodDayStatus = options.foodDayStatus ?? defaultFoodDayStatus;
      const isComplete = foodDayStatus === 'COMPLETE';
      const startDate = url.searchParams.get('start') ?? FROZEN_LOCAL_DATE;
      return fulfillJson(route, {
        start_date: startDate,
        end_date: url.searchParams.get('end') ?? startDate,
        days: [{
          date: startDate,
          status: foodDayStatus,
          origin: foodDayStatus === 'PAUSED' ? 'PAUSE' : null,
          source: foodDayStatus === 'OPEN' ? 'DEFAULT' : 'STORED',
          is_representative: isComplete,
          is_complete: isComplete,
          completed_at: isComplete ? FROZEN_NOW : null,
          updated_at: null,
        }],
      });
    }
    if (pathname === '/api/v1/food-days') {
      const foodDayStatus = options.foodDayStatus ?? defaultFoodDayStatus;
      const isComplete = foodDayStatus === 'COMPLETE';
      return fulfillJson(route, {
        date: url.searchParams.get('date') ?? FROZEN_LOCAL_DATE,
        status: foodDayStatus,
        origin: foodDayStatus === 'PAUSED' ? 'PAUSE' : null,
        source: foodDayStatus === 'OPEN' ? 'DEFAULT' : 'STORED',
        is_representative: isComplete,
        is_complete: isComplete,
        completed_at: isComplete ? FROZEN_NOW : null,
        updated_at: null,
      });
    }
    if (pathname === '/api/v1/user/tracking-history') {
      return fulfillJson(route, { tracking_start_date: '2026-01-01' });
    }
    if (pathname === '/api/v1/calibration/status') {
      return fulfillJson(route, {
        ...CALIBRATION_STATUS_RESPONSE,
        planStatus: caloriePlan.profile.calorieSummary.planStatus,
        planReasonCode: caloriePlan.profile.calorieSummary.planReasonCode,
      });
    }
    if (pathname === '/api/v1/activity/days') {
      const localDate = url.searchParams.get('start') ?? FROZEN_LOCAL_DATE;
      return fulfillJson(route, {
        start_date: localDate,
        end_date: url.searchParams.get('end') ?? localDate,
        days: [],
      });
    }
    if (pathname === '/api/v1/goals') return fulfillJson(route, caloriePlan.goal);
    if (pathname === '/api/v1/metrics' && url.searchParams.get('include_trend') === 'true') {
      if (trendUnavailable) {
        const rawTrendMetrics = trendMetrics.map((metric) => ({
          ...metric,
          trend_is_materialized: false,
          trend_weight: metric.weight,
          trend_ci_lower: metric.weight,
          trend_ci_upper: metric.weight,
          trend_std: 0,
        }));
        return fulfillJson(route, {
          metrics: rawTrendMetrics,
          meta: {
            weekly_rate: 0,
            volatility: 'low',
            total_points: rawTrendMetrics.length,
            total_span_days: 14,
            trend_summary: {
              status: 'unavailable',
              evidence: 'insufficient',
              freshness: 'unavailable',
              model_version: null,
              as_of_date: FROZEN_LOCAL_DATE,
              scope_start_date: '2026-07-04',
              scope_end_date: '2026-07-18',
              latest_observation_date: '2026-07-18',
              days_since_latest: 3,
              modeled_start_date: null,
              returned_points: rawTrendMetrics.length,
              modeled_points: 0,
              modeled_observations: 0,
              returned_modeled_points: 0,
              observation_span_days: 0,
              segment_start_date: null,
              interval_kind: 'latent_weight_model_uncertainty',
              confidence_level: 0.95,
              latest_trend: null,
              weekly_rate: null,
              short_term_variation: null,
            },
          },
        });
      }
      return fulfillJson(route, {
        metrics: trendMetrics,
        meta: { weekly_rate: -0.55, volatility: 'low', total_points: trendMetrics.length, total_span_days: 14 },
      });
    }
    if (pathname === '/api/v1/metrics') return fulfillJson(route, metrics);
    if (pathname.startsWith('/api/') || pathname.startsWith('/auth/')) {
      diagnosticsByPage.get(page)?.unexpectedApiRequests.push(`${route.request().method()} ${pathname}`);
      return fulfillApiError(route, 501, 'SERVER_ERROR', 'Unhandled deterministic fixture request');
    }
    return route.continue();
  });
}

async function installState(
  page: Page,
  context: BrowserContext,
  state: UxFixtureState,
  options: AuthenticatedApiOptions,
): Promise<UxStateController> {
  let resolveLoading = () => {};
  const loadingReleased = new Promise<void>((resolve) => {
    resolveLoading = resolve;
  });
  if (state === 'signed-out') {
    await installSignedOutApi(page);
  } else {
    await installAuthenticatedApi(page, state === 'offline' ? 'populated' : state, options, loadingReleased);
  }
  return {
    activateOffline: () => activateFixtureOffline(page),
    releaseLoading: resolveLoading,
  };
}

function attachFixtureDiagnostics(page: Page, diagnostics: FixtureDiagnostics): void {
  if (diagnosticsByPage.has(page)) return;
  diagnosticsByPage.set(page, diagnostics);
  page.on('pageerror', (error) => diagnostics.browserErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (
      diagnostics.intentionalOffline
      && message.text() === 'Failed to load resource: net::ERR_INTERNET_DISCONNECTED'
    ) return;
    const resourceStatus = Number(RESOURCE_ERROR_STATUS_PATTERN.exec(message.text())?.[1]);
    if (Number.isInteger(resourceStatus)) {
      diagnostics.resourceErrors.set(resourceStatus, (diagnostics.resourceErrors.get(resourceStatus) ?? 0) + 1);
      return;
    }
    diagnostics.browserErrors.push(`console.error: ${message.text()}`);
  });
  page.on('requestfailed', (request) => {
    const pathname = new URL(request.url()).pathname;
    diagnostics.lastFailedRequest = `${request.method()} ${pathname} (${request.failure()?.errorText ?? 'failed'})`;
  });
  page.on('response', (response) => {
    if (response.status() < 400) return;
    const request = response.request();
    const pathname = new URL(request.url()).pathname;
    diagnostics.lastFailedRequest = `${request.method()} ${pathname} (${response.status()})`;
    const key = apiFailureKey({ method: request.method(), pathname, status: response.status() });
    if (diagnostics.expectedApiFailures.has(key)) {
      diagnostics.expectedResourceErrors.set(
        response.status(),
        (diagnostics.expectedResourceErrors.get(response.status()) ?? 0) + 1,
      );
    }
  });
}
export const test = base.extend<{ ux: UxHarness; diagnostics: void; manualClock: boolean }>({
  manualClock: [false, { option: true }],
  diagnostics: [async ({ page, manualClock }, use, testInfo) => {
    const diagnostics: FixtureDiagnostics = {
      browserErrors: [],
      unexpectedApiRequests: [],
      lastFailedRequest: null,
      expectedApiFailures: new Set(),
      expectedResourceErrors: new Map(),
      resourceErrors: new Map(),
    };
    attachFixtureDiagnostics(page, diagnostics);
    await freezeBrowserInputs(page, manualClock);


    await use();

    for (const [status, count] of diagnostics.resourceErrors) {
      const unexpectedCount = Math.max(0, count - (diagnostics.expectedResourceErrors.get(status) ?? 0));
      for (let index = 0; index < unexpectedCount; index += 1) {
        diagnostics.browserErrors.push(`console.error: unexpected resource response (${status})`);
      }
    }

    const failureContext = formatFailureContext(page, testInfo, diagnostics);
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('failure-context.json', {
        body: Buffer.from(JSON.stringify({
          context: failureContext,
          browserErrors: diagnostics.browserErrors,
          unexpectedApiRequests: diagnostics.unexpectedApiRequests,
        }, null, 2)),
        contentType: 'application/json',
      });
      console.error(`[expo-web failure] ${failureContext}`);
    }
    expect.soft(diagnostics.browserErrors, `Browser errors; ${failureContext}`).toEqual([]);
    expect.soft(diagnostics.unexpectedApiRequests, `Unhandled API requests; ${failureContext}`).toEqual([]);
  }, { auto: true }],
  ux: async ({ page, context, manualClock }, use) => {
    let installed: { state: UxFixtureState; options: AuthenticatedApiOptions } | null = null;
    await use({
      install: async (state, options = {}) => {
        if (installed) throw new Error('Only one deterministic UX state may be installed per test.');
        installed = { state, options };
        return installState(page, context, state, options);
      },
      installOnPage: async (additionalPage) => {
        if (!installed) throw new Error('Install a deterministic UX state before adding a page.');
        const diagnostics = diagnosticsByPage.get(page);
        if (!diagnostics) throw new Error('Primary page diagnostics must be installed before adding a page.');
        attachFixtureDiagnostics(additionalPage, diagnostics);
        await freezeBrowserInputs(additionalPage, manualClock);
        return installState(additionalPage, context, installed.state, installed.options);
      },
    });
  },
});

export { expect };
