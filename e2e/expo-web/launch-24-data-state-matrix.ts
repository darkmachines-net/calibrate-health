/** @file launch 24 data state matrix: One reviewed primary resource and truthful surface contract for every data-backed route. */

import type { ApiResourceFixture } from './fixtures';
import { PLAN_CHECK_RECOMMENDATION_STATUS } from './plan-check.fixture';
import {
  ROUTE_REGISTRY,
  type RouteId,
} from '../../mobile/src/navigation/routeRegistry';

export const LAUNCH_24_DATA_STATES = [
  'loading',
  'content',
  'empty',
  'error',
  'stale',
  'offline',
] as const;

export type SurfaceExpectation = {
  kind: 'label' | 'text' | 'testId';
  value: string;
};

export type Launch24DataRouteCase = {
  id: RouteId;
  path: string;
  resource: Omit<ApiResourceFixture, 'state'>;
  setup?: 'restricted-legal' | 'health-connect-ready';
  loading: SurfaceExpectation;
  content: SurfaceExpectation;
  contentVisibleWhileLoading?: boolean;
  empty: SurfaceExpectation;
  errorText: string;
  errorActionText?: string;
  staleText: string;
  offlineText?: string;
  terminalEmptyText?: string;
};

const LOCAL_DATE = '2026-07-21';

const EMPTY_PLAN_CHECK_STATUS = {
  ...PLAN_CHECK_RECOMMENDATION_STATUS,
  recommendation: null,
  evaluation: {
    ...PLAN_CHECK_RECOMMENDATION_STATUS.evaluation,
    status: 'not_ready',
    recommendation: null,
    selectedWindowDays: null,
    assessment: {
      ...PLAN_CHECK_RECOMMENDATION_STATUS.evaluation.assessment,
      state: 'waiting',
      paceStatus: null,
      window: null,
      recentWeightTrendKgPerWeek: null,
      blocker: 'weight_history',
      targetDecision: 'waiting',
    },
  },
};

const GOAL = {
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

const FOOD_ENTRY = {
  id: 31,
  meal_period: 'BREAKFAST',
  name: 'Fixture breakfast',
  calories: 360,
  servings_consumed: 1,
};

const TREND_METRIC = {
  id: 3,
  user_id: 17,
  date: '2026-07-18',
  weight: 88.2,
  body_fat_percent: null,
  trend_weight: 88.4,
  trend_ci_lower: 88,
  trend_ci_upper: 88.8,
  trend_std: 0.2,
  trend_is_materialized: true,
};

const TREND_RESPONSE = {
  metrics: [
    {
      ...TREND_METRIC,
      id: 1,
      date: '2026-07-04',
      weight: 90,
      trend_weight: 89.8,
      trend_ci_lower: 89.4,
      trend_ci_upper: 90.2,
    },
    TREND_METRIC,
  ],
  meta: {
    weekly_rate: -0.55,
    volatility: 'low',
    total_points: 2,
    total_span_days: 14,
  },
};

const LEGAL_STATUS = {
  account_access: {
    state: 'legal_acceptance_required',
    email_verified: true,
    legal_current: false,
  },
  required: {
    terms_version: '2026-08-09',
    privacy_version: '2026-07-24',
  },
  accepted: {
    terms_version: '2026-01-01',
    privacy_version: '2026-01-01',
    accepted_at: '2026-01-01T12:00:00.000Z',
  },
};

const EMPTY_LEGAL_STATUS = {
  ...LEGAL_STATUS,
  accepted: {
    terms_version: null,
    privacy_version: null,
    accepted_at: null,
  },
};

const SAVED_FOOD = {
  id: 81,
  type: 'FOOD',
  name: 'Launch matrix oats',
  serving_size_quantity: 1,
  serving_unit_label: 'bowl',
  calories_per_serving: 320,
  is_pinned: true,
};

function foodDay(url: URL, status: 'OPEN' | 'INCOMPLETE') {
  return {
    date: url.searchParams.get('date') ?? LOCAL_DATE,
    status,
    origin: null,
    source: status === 'OPEN' ? 'DEFAULT' : 'STORED',
    is_representative: false,
    is_complete: false,
    completed_at: null,
    updated_at: null,
  };
}

function activityResponse(url: URL, populated: boolean) {
  const startDate = url.searchParams.get('start') ?? LOCAL_DATE;
  const endDate = url.searchParams.get('end') ?? startDate;
  if (!populated) return { start_date: startDate, end_date: endDate, days: [] };
  const day = {
    local_date: startDate,
    summary: {
      id: 201,
      local_date: startDate,
      steps: 8_432,
      active_calories_kcal: 540,
      total_calories_kcal: 2_480,
      exercise_minutes: 38,
      observed_at: `${startDate}T18:30:00.000Z`,
      created_at: `${startDate}T18:31:00.000Z`,
      updated_at: `${startDate}T18:31:00.000Z`,
    },
    records: [],
  };
  return { start_date: startDate, end_date: endDate, days: [day] };
}

function routeCase(
  id: Launch24DataRouteCase['id'],
  definition: Omit<Launch24DataRouteCase, 'id' | 'path'>,
): Launch24DataRouteCase {
  return {
    id,
    path: ROUTE_REGISTRY[id].path,
    ...definition,
  };
}

function settingsCategoryRouteCase(
  id: Launch24DataRouteCase['id'],
  testId: string,
): Launch24DataRouteCase {
  return routeCase(id, {
    resource: {
      pathname: '/api/v1/goals',
      content: GOAL,
      empty: null,
    },
    loading: { kind: 'text', value: 'Loading your current goal...' },
    content: { kind: 'testId', value: testId },
    contentVisibleWhileLoading: true,
    empty: { kind: 'testId', value: testId },
    errorText: "Can't load your current goal",
    staleText: "Couldn't refresh your current goal",
  });
}

/** One reviewed primary resource and truthful surface contract for every data-backed route. */
export const LAUNCH_24_DATA_ROUTE_CASES = [
  routeCase('legal-update', {
    setup: 'restricted-legal',
    resource: {
      pathname: '/api/v1/legal/status',
      content: LEGAL_STATUS,
      empty: EMPTY_LEGAL_STATUS,
    },
    loading: { kind: 'text', value: 'Loading legal status...' },
    content: { kind: 'text', value: 'Review the current Terms and Privacy policy. Your existing data remains available for export or deletion if you choose not to accept.' },
    empty: { kind: 'text', value: 'Review the current Terms and Privacy policy. Your existing data remains available for export or deletion if you choose not to accept.' },
    errorText: 'Unable to update your legal acceptance. Try again.',
    staleText: 'Unable to update your legal acceptance. Try again.',
  }),
  routeCase('today', {
    resource: {
      pathname: '/api/v1/food',
      content: [FOOD_ENTRY],
      empty: [],
      matches: (url) => (url.searchParams.get('date') ?? LOCAL_DATE) === LOCAL_DATE,
    },
    loading: { kind: 'testId', value: 'log-content-loading' },
    content: { kind: 'testId', value: `food-preview-entry-${FOOD_ENTRY.id}` },
    empty: { kind: 'text', value: "Start today's food log" },
    errorText: "Can't load today's log",
    staleText: "Couldn't refresh today's log",
    terminalEmptyText: "Start today's food log",
  }),
  routeCase('progress', {
    resource: {
      pathname: '/api/v1/goals',
      content: GOAL,
      empty: null,
    },
    loading: { kind: 'testId', value: 'progress-loading' },
    content: { kind: 'text', value: 'Current target: 2,100 kcal/day' },
    empty: { kind: 'text', value: 'Set a goal to add progress and projection details.' },
    errorText: "Can't load goal progress",
    staleText: "Couldn't refresh goal progress",
    terminalEmptyText: 'Set a goal to add progress and projection details.',
  }),
  routeCase('plan-check', {
    resource: {
      pathname: '/api/v1/calibration/status',
      content: PLAN_CHECK_RECOMMENDATION_STATUS,
      empty: EMPTY_PLAN_CHECK_STATUS,
    },
    loading: { kind: 'label', value: 'Loading plan check' },
    content: { kind: 'text', value: 'Your recent weight trend is slower than your goal' },
    empty: { kind: 'text', value: 'Not enough history for a reliable plan check' },
    errorText: "Can't load plan check",
    errorActionText: 'Retry',
    staleText: "Couldn't refresh plan check",
    offlineText: 'Offline - showing saved information',
    terminalEmptyText: 'Not enough history for a reliable plan check',
  }),
  routeCase('settings', {
    resource: {
      pathname: '/api/v1/goals',
      content: GOAL,
      empty: null,
    },
    loading: { kind: 'text', value: 'Loading current goal...' },
    content: { kind: 'text', value: 'Lose to 82 kg | 500 kcal/day deficit' },
    empty: { kind: 'text', value: 'No active goal set' },
    errorText: "Can't load your current goal",
    staleText: "Couldn't refresh your current goal",
    terminalEmptyText: 'No active goal set',
  }),
  settingsCategoryRouteCase('settings-profile', 'settings-category-profile'),
  routeCase('devices', {
    resource: {
      pathname: '/auth/sessions',
      content: {
        sessions: [
          {
            id: 'browser_current',
            kind: 'browser',
            device_label: 'Chrome on Windows',
            created_at: '2026-08-01T12:00:00.000Z',
            last_activity_at: '2026-08-27T12:00:00.000Z',
            current: true,
          },
          {
            id: 'mobile_remote',
            kind: 'android_phone',
            device_label: 'Pixel 9',
            created_at: '2026-07-01T12:00:00.000Z',
            last_activity_at: null,
            current: false,
          },
        ],
      },
      empty: { sessions: [] },
    },
    loading: { kind: 'label', value: 'Loading active devices' },
    content: { kind: 'text', value: 'Pixel 9' },
    empty: { kind: 'text', value: 'No signed-in sessions found' },
    errorText: "Can't load signed-in sessions",
    staleText: "Couldn't refresh signed-in sessions",
    offlineText: 'Offline - showing saved information',
    terminalEmptyText: 'No signed-in sessions found',
  }),
  routeCase('connected-apps', {
    resource: {
      pathname: '/api/v1/user/connected-apps',
      content: {
        connections: [{
          id: 'c13e23d9-b130-42bd-bb70-901fd65fbfe9',
          client_id: 'codex-client',
          client_name: 'Codex',
          scopes: ['calibrate:food:read', 'calibrate:weight:read'],
          resource: 'https://calibratehealth.app/mcp',
          created_at: '2026-08-19T12:00:00.000Z',
          last_used_at: null,
          expires_at: '2026-09-18T12:00:00.000Z',
        }],
      },
      empty: { connections: [] },
    },
    loading: { kind: 'label', value: 'Loading connected assistants' },
    content: { kind: 'text', value: 'Codex' },
    empty: { kind: 'text', value: 'No connected assistants' },
    errorText: "Can't load connected assistants",
    staleText: "Couldn't refresh connected assistants",
    offlineText: 'Offline - showing saved information',
    terminalEmptyText: 'No connected assistants',
  }),
  routeCase('food-log', {
    resource: {
      pathname: '/api/v1/food',
      content: [FOOD_ENTRY],
      empty: [],
      matches: (url) => (url.searchParams.get('date') ?? LOCAL_DATE) === LOCAL_DATE,
    },
    loading: { kind: 'testId', value: 'food-log-loading' },
    content: { kind: 'text', value: 'Fixture breakfast' },
    empty: { kind: 'text', value: 'Meals' },
    errorText: "Can't load food log",
    staleText: "Couldn't refresh food log",
    terminalEmptyText: 'Meals',
  }),
  routeCase('weight-trend', {
    resource: {
      pathname: '/api/v1/metrics',
      content: TREND_RESPONSE,
      empty: {
        metrics: [],
        meta: { weekly_rate: 0, volatility: 'low', total_points: 0, total_span_days: 0 },
      },
      matches: (url) => url.searchParams.get('include_trend') === 'true',
    },
    loading: { kind: 'text', value: 'Loading trend...' },
    content: { kind: 'testId', value: 'weight-trend-chart' },
    empty: { kind: 'text', value: 'Log a weigh-in to start a trend.' },
    errorText: "Can't load weight trend",
    staleText: "Couldn't refresh weight trend",
    terminalEmptyText: 'Log a weigh-in to start a trend.',
  }),
  routeCase('activity', {
    setup: 'health-connect-ready',
    resource: {
      pathname: '/api/v1/activity/days',
      content: (url) => activityResponse(url, true),
      empty: (url) => activityResponse(url, false),
    },
    loading: { kind: 'text', value: 'Loading recent activity...' },
    content: { kind: 'text', value: '8,432' },
    empty: { kind: 'text', value: 'No imported activity for this day' },
    errorText: "Can't load selected-day activity",
    staleText: "Couldn't refresh selected-day activity",
    terminalEmptyText: 'No imported activity for this day',
  }),
  routeCase('server-admin', {
    resource: {
      pathname: '/api/v1/server-settings',
      content: { is_admin: true, features: { nutrition_label_scanning: true } },
      empty: { is_admin: true, features: { nutrition_label_scanning: false } },
    },
    loading: { kind: 'text', value: 'Loading server settings...' },
    content: { kind: 'text', value: 'Manage settings for the connected Calibrate server.' },
    contentVisibleWhileLoading: true,
    empty: { kind: 'text', value: 'Manage settings for the connected Calibrate server.' },
    errorText: 'Server settings could not be loaded.',
    errorActionText: 'Try again',
    staleText: 'Server settings could not be loaded.',
    offlineText: 'Connect to the server to manage its settings.',
  }),
  routeCase('my-foods', {
    resource: {
      pathname: '/api/v1/my-foods/library',
      content: { items: [SAVED_FOOD], next_cursor: null },
      empty: { items: [], next_cursor: null },
    },
    loading: { kind: 'testId', value: 'saved-foods-loading' },
    content: { kind: 'text', value: 'Launch matrix oats' },
    empty: { kind: 'text', value: 'No saved foods yet. Create a food or recipe to reuse it when logging.' },
    errorText: "Can't load saved foods",
    staleText: "Couldn't refresh saved foods",
    terminalEmptyText: 'No saved foods yet. Create a food or recipe to reuse it when logging.',
  }),
  routeCase('weight', {
    resource: {
      pathname: '/api/v1/metrics',
      content: [{ id: 3, date: LOCAL_DATE, weight: 88.2 }],
      empty: [],
      matches: (url) => url.searchParams.get('include_trend') === null,
    },
    loading: { kind: 'text', value: 'Loading your latest weigh-in...' },
    content: { kind: 'text', value: 'Editing the weigh-in already saved for this day.' },
    empty: { kind: 'text', value: 'Log weight' },
    errorText: 'Calibrate had trouble loading this information. Try again.',
    staleText: 'Calibrate had trouble loading this information. Try again.',
    offlineText: 'Offline - using saved weigh-ins.',
  }),
  routeCase('barcode', {
    resource: {
      pathname: '/api/v1/food-days',
      content: (url) => foodDay(url, 'OPEN'),
      empty: (url) => foodDay(url, 'INCOMPLETE'),
    },
    loading: { kind: 'text', value: 'Checking tracking status...' },
    content: { kind: 'text', value: 'Enter barcode' },
    empty: { kind: 'text', value: 'Food logging is unavailable' },
    errorText: "Can't load tracking status",
    errorActionText: 'Retry',
    staleText: "Couldn't refresh tracking status",
    terminalEmptyText: 'Food logging is unavailable',
  }),
] as const satisfies readonly Launch24DataRouteCase[];

export const LAUNCH_24_STATIC_ROUTE_IDS = [
  'root',
  'onboarding',
  'login',
  'register',
  'forgot-password',
  'reset-password',
  'verify-email',
  'terms',
  'support',
  'privacy',
  'account-deletion',
  'health-connect-privacy',
  'settings-security',
  'settings-connections',
  'settings-data',
  'settings-help',
  'profile-details',
  'preferences',
  'health-connect',
  'watch',
  'about',
  'advanced',
  // This form scans and saves only after user actions; it has no initial data resource.
  'nutrition-label',
] as const satisfies readonly RouteId[];
