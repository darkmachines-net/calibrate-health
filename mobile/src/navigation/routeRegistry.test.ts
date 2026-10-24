/** @file Regression coverage for route Registry: route registry. */

import {
  REGISTERED_ROUTE_PATHS,
  ROUTE_IDS,
  ROUTE_REGISTRY,
  canonicalPathForRoute,
  getRouteByPath,
  getRouteFallback,
  getRouteParent,
  isRouteActive,
  type RouteId,
} from './routeRegistry';

describe('route registry', () => {
  it('is exhaustive and has one owner for every canonical and alias path', () => {
    expect(Object.keys(ROUTE_REGISTRY)).toEqual(ROUTE_IDS);
    expect(new Set(REGISTERED_ROUTE_PATHS).size).toBe(REGISTERED_ROUTE_PATHS.length);

    for (const path of REGISTERED_ROUTE_PATHS) {
      expect(path).toMatch(/^\/(?:[^/].*)?$/);
      if (path !== '/') expect(path.endsWith('/')).toBe(false);
      expect(getRouteByPath(path)).not.toBeNull();
    }
  });

  it('declares valid hierarchy, fallback, title, and shell metadata', () => {
    for (const routeId of ROUTE_IDS) {
      const definition = ROUTE_REGISTRY[routeId];
      expect(definition.title.trim()).not.toBe('');
      expect(definition.documentTitle.trim()).not.toBe('');

      if (definition.parent) {
        expect(ROUTE_IDS).toContain(definition.parent);
        expect(getRouteParent(routeId)).toBe(ROUTE_REGISTRY[definition.parent]);
      } else {
        expect(getRouteParent(routeId)).toBeNull();
      }

      if (definition.fallback) {
        expect(ROUTE_IDS).toContain(definition.fallback);
        expect(getRouteFallback(routeId)).toBe(ROUTE_REGISTRY[definition.fallback]);
        expect(definition.backLabel).not.toBeNull();
      } else {
        expect(getRouteFallback(routeId)).toBeNull();
      }

      if (definition.shellPolicy === 'app') {
        expect(definition.authClass).toBe('authenticated');
      }
    }
  });

  it('keeps the launch hierarchy and parent fallbacks explicit', () => {
    const expectedParents = {
      'settings-profile': 'settings',
      'settings-security': 'settings',
      'settings-connections': 'settings',
      'settings-data': 'settings',
      'settings-help': 'settings',
      'profile-details': 'settings-profile',
      'preferences': 'settings-profile',
      'health-connect': 'settings-connections',
      'watch': 'settings-connections',
      'devices': 'settings-security',
      'connected-apps': 'settings-connections',
      'food-log': 'today',
      'weight-trend': 'progress',
      activity: 'settings-connections',
      'my-foods': 'settings-data',
      about: 'settings-help',
      advanced: 'settings-help',
      weight: 'progress',
      barcode: 'today',
    } as const satisfies Partial<Record<RouteId, RouteId>>;

    for (const [routeId, parent] of Object.entries(expectedParents)) {
      const definition = ROUTE_REGISTRY[routeId as RouteId];
      expect(definition.parent).toBe(parent);
      expect(definition.fallback).toBe(parent);
    }
  });

  it('uses the same Saved foods label as its Settings navigation action', () => {
    expect(ROUTE_REGISTRY['my-foods'].title).toBe('Saved foods');
    expect(ROUTE_REGISTRY['my-foods'].documentTitle).toBe('Saved foods - Calibrate');
  });
  it('registers focused Settings category paths and presentation metadata', () => {
    expect(ROUTE_REGISTRY['settings-profile']).toMatchObject({
      path: '/profile',
      title: 'Profile & preferences',
      backLabel: 'Back to Settings',
    });
    expect(ROUTE_REGISTRY['settings-security']).toMatchObject({
      path: '/security',
      title: 'Security & access',
      backLabel: 'Back to Settings',
    });
    expect(ROUTE_REGISTRY['settings-connections']).toMatchObject({
      path: '/connections',
      title: 'Connections',
      backLabel: 'Back to Settings',
    });
    expect(ROUTE_REGISTRY['settings-data']).toMatchObject({
      path: '/data',
      title: 'Data & privacy',
      backLabel: 'Back to Settings',
    });
    expect(ROUTE_REGISTRY['settings-help']).toMatchObject({
      path: '/help',
      title: 'Help & app',
      backLabel: 'Back to Settings',
    });
  });
  it('lets authenticated users reach onboarding so runtime completion state decides the redirect', () => {
    expect(ROUTE_REGISTRY.onboarding.authenticatedRedirect).toBeNull();
  });
  it('preserves the exported production root document title', () => {
    expect(ROUTE_REGISTRY.root.documentTitle).toBe('calibrate');
  });
  it('resolves canonical paths and redirect aliases without route-name guessing', () => {
    expect(canonicalPathForRoute('weight-trend')).toBe('/weight-trend');
    expect(getRouteByPath('/weight-trend/?range=month')).toMatchObject({
      routeId: 'weight-trend',
      canonicalPath: '/weight-trend',
      matchedPath: '/weight-trend',
      isAlias: false,
    });
    expect(getRouteByPath('/log')).toMatchObject({
      routeId: 'today',
      canonicalPath: '/today',
      matchedPath: '/log',
      isAlias: true,
    });
    expect(getRouteByPath('/goals')).toMatchObject({
      routeId: 'progress',
      canonicalPath: '/progress',
      matchedPath: '/goals',
      isAlias: true,
    });
    expect(getRouteByPath('/not-registered')).toBeNull();
    expect(getRouteByPath('/notifications?cursor=old#history')).toBeNull();
    expect(getRouteByPath('/notifications/old')).toBeNull();
  });
  it('recognizes the active route without treating another stack entry as active', () => {
    expect(isRouteActive('/today', 'today')).toBe(true);
    expect(isRouteActive('/log', 'today')).toBe(true);
    expect(isRouteActive('/progress', 'today')).toBe(false);
    expect(isRouteActive('/missing', 'today')).toBe(false);
  });
});
