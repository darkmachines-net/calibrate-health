/** @file ux matrix: Canonical destinations only; alias redirect behavior remains covered by route-matrix.spec.ts. */

import {
  ROUTE_IDS,
  ROUTE_REGISTRY,
  type RouteAuthClass,
  type RouteId,
} from '../../mobile/src/navigation/routeRegistry';
import type { UxFixtureState } from './fixtures';

export type UxLocatorContract =
  | {
      kind: 'role';
      role: 'button' | 'combobox' | 'dialog' | 'heading' | 'main';
      name?: string | RegExp;
      exact?: boolean;
    }
  | {
      kind: 'test-id';
      value: string;
    };

export type UxAccessibilityRouteCase = {
  id: RouteId;
  path: string;
  authClass: RouteAuthClass;
  fixtureState: Extract<UxFixtureState, 'signed-out' | 'populated'>;
  ready: UxLocatorContract;
};

export type UxAccessibilityOverlayCase = {
  id: string;
  routeId: RouteId;
  path: string;
  fixtureState: Extract<UxFixtureState, 'populated'>;
  open: readonly UxLocatorContract[];
  opensAutomatically?: boolean;
  ready: UxLocatorContract;
};

function routeReadyContract(routeId: RouteId): UxLocatorContract {
  if (routeId === 'root') return { kind: 'test-id', value: 'hosted-landing' };
  if (routeId === 'weight') {
    return { kind: 'role', role: 'dialog', name: 'Weight entry', exact: true };
  }
  if (routeId === 'barcode') {
    return {
      kind: 'role',
      role: 'heading',
      name: /Camera permission|Scan barcode|Food logging is unavailable/,
    };
  }
  if (routeId === 'onboarding') return { kind: 'role', role: 'main' };
  return {
    kind: 'role',
    role: 'heading',
    name: ROUTE_REGISTRY[routeId].title,
    exact: true,
  };
}

/** Canonical destinations only; alias redirect behavior remains covered by route-matrix.spec.ts. */
export const UX_ACCESSIBILITY_ROUTE_CASES: readonly UxAccessibilityRouteCase[] = ROUTE_IDS.map(
  (routeId) => {
    const definition = ROUTE_REGISTRY[routeId];
    return {
      id: routeId,
      path: definition.path,
      authClass: definition.authClass,
      fixtureState: definition.authClass === 'authenticated' ? 'populated' : 'signed-out',
      ready: routeReadyContract(routeId),
    };
  },
);

/**
 * Exhaustive current-production inventory of deterministic web overlay entry points.
 * New production overlays must be added here with an activation path or explicit automatic state.
 */
export const UX_ACCESSIBILITY_OVERLAY_CASES: readonly UxAccessibilityOverlayCase[] = [
  {
    id: 'add-food',
    routeId: 'today',
    path: ROUTE_REGISTRY.today.path,
    fixtureState: 'populated',
    open: [{ kind: 'role', role: 'button', name: 'Add food', exact: true }],
    ready: { kind: 'role', role: 'dialog', name: 'Add food', exact: true },
  },
  {
    id: 'weight-entry',
    routeId: 'today',
    path: ROUTE_REGISTRY.today.path,
    fixtureState: 'populated',
    open: [{ kind: 'test-id', value: 'today-weight-card-press-layer' }],
    ready: { kind: 'role', role: 'dialog', name: 'Weight entry', exact: true },
  },
  {
    id: 'historical-calendar',
    routeId: 'today',
    path: ROUTE_REGISTRY.today.path,
    fixtureState: 'populated',
    open: [{ kind: 'role', role: 'button', name: 'Choose date', exact: true }],
    ready: { kind: 'role', role: 'dialog', name: 'Calendar', exact: true },
  },
  {
    id: 'goal-editor',
    routeId: 'progress',
    path: ROUTE_REGISTRY.progress.path,
    fixtureState: 'populated',
    open: [{
      kind: 'role',
      role: 'button',
      name: /Edit goal|Review calorie plan|Set goal/,
    }],
    ready: { kind: 'role', role: 'dialog', name: 'Set a new goal', exact: true },
  },
  {
    id: 'goal-daily-calorie-options',
    routeId: 'progress',
    path: ROUTE_REGISTRY.progress.path,
    fixtureState: 'populated',
    open: [
      { kind: 'role', role: 'button', name: /Edit goal|Review calorie plan|Set goal/ },
      { kind: 'role', role: 'combobox', name: 'Select daily calorie change', exact: true },
    ],
    ready: {
      kind: 'role',
      role: 'dialog',
      name: 'Select daily calorie change',
      exact: true,
    },
  },
  {
    id: 'plan-check-adjustment-review',
    routeId: 'progress',
    path: ROUTE_REGISTRY.progress.path,
    fixtureState: 'populated',
    open: [{ kind: 'test-id', value: 'plan-check-summary' }, {
      kind: 'role',
      role: 'button',
      name: 'Review suggested 1,750 calorie daily target',
      exact: true,
    }],
    ready: {
      kind: 'role',
      role: 'dialog',
      name: 'Review calorie target',
      exact: true,
    },
  },
  {
    id: 'notifications-drawer',
    routeId: 'today',
    path: ROUTE_REGISTRY.today.path,
    fixtureState: 'populated',
    open: [{ kind: 'test-id', value: 'notifications-button' }],
    ready: { kind: 'role', role: 'dialog', name: 'Notifications', exact: true },
  },
  {
    id: 'profile-time-zone-options',
    routeId: 'profile-details',
    path: ROUTE_REGISTRY['profile-details'].path,
    fixtureState: 'populated',
    open: [
      { kind: 'role', role: 'combobox', name: 'Time zone', exact: true },
    ],
    ready: { kind: 'role', role: 'dialog', name: 'Time zone', exact: true },
  },
  {
    id: 'profile-photo',
    routeId: 'settings-profile',
    path: ROUTE_REGISTRY['settings-profile'].path,
    fixtureState: 'populated',
    open: [{ kind: 'role', role: 'button', name: 'Profile photo', exact: true }],
    ready: { kind: 'role', role: 'dialog', name: 'Profile photo', exact: true },
  },
  {
    id: 'password',
    routeId: 'settings-security',
    path: ROUTE_REGISTRY['settings-security'].path,
    fixtureState: 'populated',
    open: [{ kind: 'role', role: 'button', name: 'Password', exact: true }],
    ready: { kind: 'role', role: 'dialog', name: 'Password', exact: true },
  },
  {
    id: 'import',
    routeId: 'settings-data',
    path: ROUTE_REGISTRY['settings-data'].path,
    fixtureState: 'populated',
    open: [{ kind: 'role', role: 'button', name: 'Import from Lose It', exact: true }],
    ready: { kind: 'role', role: 'dialog', name: 'Import from Lose It', exact: true },
  },
  {
    id: 'offline',
    routeId: 'settings-data',
    path: ROUTE_REGISTRY['settings-data'].path,
    fixtureState: 'populated',
    open: [{ kind: 'role', role: 'button', name: /^Offline changes/ }],
    ready: { kind: 'role', role: 'dialog', name: 'Offline changes', exact: true },
  },
  {
    id: 'saved-food-new-food',
    routeId: 'my-foods',
    path: ROUTE_REGISTRY['my-foods'].path,
    fixtureState: 'populated',
    open: [{ kind: 'role', role: 'button', name: 'Create food', exact: true }],
    ready: { kind: 'role', role: 'dialog', name: 'New food', exact: true },
  },
  {
    id: 'saved-food-new-recipe',
    routeId: 'my-foods',
    path: ROUTE_REGISTRY['my-foods'].path,
    fixtureState: 'populated',
    open: [{ kind: 'role', role: 'button', name: 'Create recipe', exact: true }],
    ready: { kind: 'role', role: 'dialog', name: 'Recipe builder', exact: true },
  },
  {
    id: 'food-log-edit',
    routeId: 'food-log',
    path: ROUTE_REGISTRY['food-log'].path,
    fixtureState: 'populated',
    open: [{ kind: 'role', role: 'button', name: 'Edit Fixture breakfast', exact: true }],
    ready: { kind: 'role', role: 'dialog', name: 'Edit food', exact: true },
  },
  {
    id: 'food-log-copy-day',
    routeId: 'food-log',
    path: ROUTE_REGISTRY['food-log'].path,
    fixtureState: 'populated',
    open: [{ kind: 'role', role: 'button', name: 'Copy day', exact: true }],
    ready: { kind: 'role', role: 'dialog', name: 'Copy day', exact: true },
  },
  {
    id: 'food-log-copy-meal',
    routeId: 'food-log',
    path: ROUTE_REGISTRY['food-log'].path,
    fixtureState: 'populated',
    open: [{ kind: 'role', role: 'button', name: 'Copy Breakfast', exact: true }],
    ready: { kind: 'role', role: 'dialog', name: 'Copy meal', exact: true },
  },
  {
    id: 'food-log-copy-meal-destination',
    routeId: 'food-log',
    path: ROUTE_REGISTRY['food-log'].path,
    fixtureState: 'populated',
    open: [
      { kind: 'role', role: 'button', name: 'Copy Breakfast', exact: true },
      { kind: 'role', role: 'combobox', name: 'Copy to meal', exact: true },
    ],
    ready: { kind: 'role', role: 'dialog', name: 'Copy to meal', exact: true },
  },
  {
    id: 'food-log-save-recipe',
    routeId: 'food-log',
    path: ROUTE_REGISTRY['food-log'].path,
    fixtureState: 'populated',
    open: [{ kind: 'role', role: 'button', name: 'Save Breakfast as recipe', exact: true }],
    ready: { kind: 'role', role: 'dialog', name: 'Save as recipe', exact: true },
  },
  {
    id: 'pause-tracking',
    routeId: 'today',
    path: ROUTE_REGISTRY.today.path,
    fixtureState: 'populated',
    open: [
      { kind: 'role', role: 'button', name: 'Choose date', exact: true },
      { kind: 'role', role: 'button', name: 'Pause tracking', exact: true },
    ],
    ready: { kind: 'role', role: 'dialog', name: 'Details', exact: true },
  },
  {
    id: 'resume-tracking-prompt',
    routeId: 'today',
    path: ROUTE_REGISTRY.today.path,
    fixtureState: 'populated',
    open: [],
    opensAutomatically: true,
    ready: { kind: 'role', role: 'dialog', name: 'Ready to resume tracking?', exact: true },
  },
  {
    id: 'session-revoke-confirmation',
    routeId: 'devices',
    path: ROUTE_REGISTRY.devices.path,
    fixtureState: 'populated',
    open: [
      { kind: 'test-id', value: 'settings-session-revoke-mobile_remote' },
    ],
    ready: { kind: 'role', role: 'dialog', name: 'Revoke signed-in session?', exact: true },
  },
  {
    id: 'session-revoke-others-confirmation',
    routeId: 'devices',
    path: ROUTE_REGISTRY.devices.path,
    fixtureState: 'populated',
    open: [{ kind: 'test-id', value: 'settings-session-revoke-others' }],
    ready: { kind: 'role', role: 'dialog', name: 'Revoke all other sessions?', exact: true },
  },
  {
    id: 'connected-app-revoke-confirmation',
    routeId: 'connected-apps',
    path: ROUTE_REGISTRY['connected-apps'].path,
    fixtureState: 'populated',
    open: [{
      kind: 'test-id',
      value: 'settings-connected-app-revoke-c13e23d9-b130-42bd-bb70-901fd65fbfe9',
    }],
    ready: { kind: 'role', role: 'dialog', name: 'Revoke connected assistant?', exact: true },
  },
  {
    id: 'account-export',
    routeId: 'settings-data',
    path: ROUTE_REGISTRY['settings-data'].path,
    fixtureState: 'populated',
    open: [{ kind: 'test-id', value: 'settings-export' }],
    ready: { kind: 'role', role: 'dialog', name: 'Export your data', exact: true },
  },
  {
    id: 'delete-account',
    routeId: 'settings-data',
    path: ROUTE_REGISTRY['settings-data'].path,
    fixtureState: 'populated',
    open: [{ kind: 'test-id', value: 'settings-delete-account' }],
    ready: { kind: 'role', role: 'dialog', name: 'Delete account permanently', exact: true },
  },
];
