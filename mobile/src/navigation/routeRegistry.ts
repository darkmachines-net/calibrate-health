/** @file route Registry: Canonical route metadata shared by the Expo shell and exported-web route tests. Route groups are intentionally absent because they never appear in public URLs. */

export const ROUTE_IDS = [
  'root',
  'login',
  'register',
  'forgot-password',
  'reset-password',
  'verify-email',
  'legal-update',
  'terms',
  'support',
  'privacy',
  'account-deletion',
  'health-connect-privacy',
  'onboarding',
  'today',
  'progress',
  'settings',
  'settings-profile',
  'settings-security',
  'settings-connections',
  'settings-data',
  'settings-help',
  'profile-details',
  'preferences',
  'health-connect',
  'watch',
  'devices',
  'connected-apps',
  'food-log',
  'weight-trend',
  'plan-check',
  'activity',
  'my-foods',
  'about',
  'advanced',
  'server-admin',
  'weight',
  'nutrition-label',
  'barcode',
] as const;

export type RouteId = (typeof ROUTE_IDS)[number];
export type RouteAuthClass = 'public' | 'signed-out-only' | 'authenticated';
type RouteShellPolicy = 'public' | 'app' | 'overlay' | 'standalone';
type RouteDeepLinkBehavior = 'render' | 'session-redirect';

export type RouteAlias = {
  path: `/${string}`;
  authenticatedRedirect: RouteId;
};

export type RouteDefinition = {
  path: '/' | `/${string}`;
  title: string;
  documentTitle: string;
  parent: RouteId | null;
  fallback: RouteId | null;
  backLabel: string | null;
  authClass: RouteAuthClass;
  shellPolicy: RouteShellPolicy;
  deepLink: RouteDeepLinkBehavior;
  authenticatedRedirect: RouteId | null;
  aliases: readonly RouteAlias[];
};

const route = (
  definition: Omit<RouteDefinition, 'documentTitle' | 'aliases'> & {
    documentTitle?: string;
    aliases?: readonly RouteAlias[];
  },
): RouteDefinition => ({
  ...definition,
  documentTitle: definition.documentTitle ?? `${definition.title} - Calibrate`,
  aliases: definition.aliases ?? [],
});

/**
 * Canonical route metadata shared by the Expo shell and exported-web route tests.
 * Route groups are intentionally absent because they never appear in public URLs.
 */
export const ROUTE_REGISTRY = {
  root: route({
    path: '/',
    title: 'Calibrate',
    documentTitle: 'calibrate',
    parent: null,
    fallback: null,
    backLabel: null,
    authClass: 'public',
    shellPolicy: 'public',
    deepLink: 'session-redirect',
    authenticatedRedirect: 'today',
  }),
  login: route({
    path: '/login',
    title: 'Sign in',
    parent: null,
    fallback: null,
    backLabel: null,
    authClass: 'signed-out-only',
    shellPolicy: 'public',
    deepLink: 'session-redirect',
    authenticatedRedirect: 'today',
  }),
  register: route({
    path: '/register',
    title: 'Create account',
    parent: null,
    fallback: null,
    backLabel: null,
    authClass: 'signed-out-only',
    shellPolicy: 'public',
    deepLink: 'session-redirect',
    authenticatedRedirect: 'today',
  }),
  'forgot-password': route({
    path: '/forgot-password',
    title: 'Reset password',
    parent: 'login',
    fallback: 'login',
    backLabel: 'Back to sign in',
    authClass: 'public',
    shellPolicy: 'public',
    deepLink: 'render',
    authenticatedRedirect: null,
  }),
  'reset-password': route({
    path: '/reset-password',
    title: 'Choose a new password',
    parent: 'login',
    fallback: 'login',
    backLabel: 'Back to sign in',
    authClass: 'public',
    shellPolicy: 'public',
    deepLink: 'render',
    authenticatedRedirect: null,
  }),
  'verify-email': route({
    path: '/verify-email',
    title: 'Verify your email',
    parent: null,
    fallback: 'login',
    backLabel: 'Back to sign in',
    authClass: 'public',
    shellPolicy: 'public',
    deepLink: 'render',
    authenticatedRedirect: null,
  }),
  'legal-update': route({
    path: '/legal-update',
    title: 'Review legal updates',
    parent: null,
    fallback: 'settings',
    backLabel: 'Back to Settings',
    authClass: 'authenticated',
    shellPolicy: 'public',
    deepLink: 'render',
    authenticatedRedirect: null,
  }),
  terms: route({
    path: '/terms',
    title: 'Terms of service',
    parent: null,
    fallback: null,
    backLabel: null,
    authClass: 'public',
    shellPolicy: 'public',
    deepLink: 'render',
    authenticatedRedirect: null,
  }),
  support: route({
    path: '/support',
    title: 'Support',
    parent: null,
    fallback: null,
    backLabel: null,
    authClass: 'public',
    shellPolicy: 'public',
    deepLink: 'render',
    authenticatedRedirect: null,
  }),
  privacy: route({
    path: '/privacy',
    title: 'Privacy policy',
    parent: null,
    fallback: null,
    backLabel: null,
    authClass: 'public',
    shellPolicy: 'public',
    deepLink: 'render',
    authenticatedRedirect: null,
  }),
  'account-deletion': route({
    path: '/account-deletion',
    title: 'Delete your Calibrate account',
    parent: null,
    fallback: null,
    backLabel: null,
    authClass: 'public',
    shellPolicy: 'public',
    deepLink: 'render',
    authenticatedRedirect: null,
  }),
  'health-connect-privacy': route({
    path: '/health-connect-privacy',
    title: 'How Calibrate uses health data',
    parent: null,
    fallback: null,
    backLabel: null,
    authClass: 'public',
    shellPolicy: 'public',
    deepLink: 'render',
    authenticatedRedirect: null,
  }),
  onboarding: route({
    path: '/onboarding',
    title: 'Set up Calibrate',
    parent: null,
    fallback: null,
    backLabel: null,
    authClass: 'authenticated',
    shellPolicy: 'standalone',
    deepLink: 'session-redirect',
    authenticatedRedirect: null,
  }),
  today: route({
    path: '/today',
    title: 'Today',
    parent: null,
    fallback: null,
    backLabel: null,
    authClass: 'authenticated',
    shellPolicy: 'app',
    deepLink: 'render',
    authenticatedRedirect: null,
    aliases: [{ path: '/log', authenticatedRedirect: 'today' }],
  }),
  progress: route({
    path: '/progress',
    title: 'Progress',
    parent: null,
    fallback: null,
    backLabel: null,
    authClass: 'authenticated',
    shellPolicy: 'app',
    deepLink: 'render',
    authenticatedRedirect: null,
    aliases: [{ path: '/goals', authenticatedRedirect: 'progress' }],
  }),
  settings: route({
    path: '/settings',
    title: 'Settings',
    parent: null,
    fallback: null,
    backLabel: null,
    authClass: 'authenticated',
    shellPolicy: 'app',
    deepLink: 'render',
    authenticatedRedirect: null,
  }),
  'settings-profile': route({
    path: '/profile',
    title: 'Profile & preferences',
    parent: 'settings',
    fallback: 'settings',
    backLabel: 'Back to Settings',
    authClass: 'authenticated',
    shellPolicy: 'app',
    deepLink: 'render',
    authenticatedRedirect: null,
  }),
  'settings-security': route({
    path: '/security',
    title: 'Security & access',
    parent: 'settings',
    fallback: 'settings',
    backLabel: 'Back to Settings',
    authClass: 'authenticated',
    shellPolicy: 'app',
    deepLink: 'render',
    authenticatedRedirect: null,
  }),
  'settings-connections': route({
    path: '/connections',
    title: 'Connections',
    parent: 'settings',
    fallback: 'settings',
    backLabel: 'Back to Settings',
    authClass: 'authenticated',
    shellPolicy: 'app',
    deepLink: 'render',
    authenticatedRedirect: null,
  }),
  'settings-data': route({
    path: '/data',
    title: 'Data & privacy',
    parent: 'settings',
    fallback: 'settings',
    backLabel: 'Back to Settings',
    authClass: 'authenticated',
    shellPolicy: 'app',
    deepLink: 'render',
    authenticatedRedirect: null,
  }),
  'settings-help': route({
    path: '/help',
    title: 'Help & app',
    parent: 'settings',
    fallback: 'settings',
    backLabel: 'Back to Settings',
    authClass: 'authenticated',
    shellPolicy: 'app',
    deepLink: 'render',
    authenticatedRedirect: null,
  }),
  'profile-details': route({
    path: '/profile-details',
    title: 'Profile details',
    parent: 'settings-profile',
    fallback: 'settings-profile',
    backLabel: 'Back to Profile & preferences',
    authClass: 'authenticated',
    shellPolicy: 'app',
    deepLink: 'render',
    authenticatedRedirect: null,
  }),
  preferences: route({
    path: '/preferences',
    title: 'Preferences',
    parent: 'settings-profile',
    fallback: 'settings-profile',
    backLabel: 'Back to Profile & preferences',
    authClass: 'authenticated',
    shellPolicy: 'app',
    deepLink: 'render',
    authenticatedRedirect: null,
  }),
  'health-connect': route({
    path: '/health-connect',
    title: 'Health Connect',
    parent: 'settings-connections',
    fallback: 'settings-connections',
    backLabel: 'Back to Connections',
    authClass: 'authenticated',
    shellPolicy: 'app',
    deepLink: 'render',
    authenticatedRedirect: null,
  }),
  watch: route({
    path: '/watch',
    title: 'Galaxy Watch',
    parent: 'settings-connections',
    fallback: 'settings-connections',
    backLabel: 'Back to Connections',
    authClass: 'authenticated',
    shellPolicy: 'app',
    deepLink: 'render',
    authenticatedRedirect: null,
  }),
  devices: route({
    path: '/devices',
    title: 'Signed-in devices',
    parent: 'settings-security',
    fallback: 'settings-security',
    backLabel: 'Back to Security & access',
    authClass: 'authenticated',
    shellPolicy: 'app',
    deepLink: 'render',
    authenticatedRedirect: null,
  }),
  'connected-apps': route({
    path: '/connected-apps',
    title: 'Connected assistants',
    parent: 'settings-connections',
    fallback: 'settings-connections',
    backLabel: 'Back to Connections',
    authClass: 'authenticated',
    shellPolicy: 'app',
    deepLink: 'render',
    authenticatedRedirect: null,
  }),
  'food-log': route({
    path: '/food-log',
    title: 'Food log',
    parent: 'today',
    fallback: 'today',
    backLabel: 'Back to Today',
    authClass: 'authenticated',
    shellPolicy: 'app',
    deepLink: 'render',
    authenticatedRedirect: null,
  }),
  'weight-trend': route({
    path: '/weight-trend',
    title: 'Trend',
    parent: 'progress',
    fallback: 'progress',
    backLabel: 'Back to Progress',
    authClass: 'authenticated',
    shellPolicy: 'app',
    deepLink: 'render',
    authenticatedRedirect: null,
  }),
  'plan-check': route({
    path: '/plan-check',
    title: 'Plan check',
    parent: 'progress',
    fallback: 'progress',
    backLabel: 'Back to Progress',
    authClass: 'authenticated',
    shellPolicy: 'app',
    deepLink: 'render',
    authenticatedRedirect: null,
  }),
  activity: route({
    path: '/activity',
    title: 'Activity',
    parent: 'settings-connections',
    fallback: 'settings-connections',
    backLabel: 'Back to Connections',
    authClass: 'authenticated',
    shellPolicy: 'app',
    deepLink: 'render',
    authenticatedRedirect: null,
  }),
  'my-foods': route({
    path: '/my-foods',
    title: 'Saved foods',
    parent: 'settings-data',
    fallback: 'settings-data',
    backLabel: 'Back to Data & privacy',
    authClass: 'authenticated',
    shellPolicy: 'app',
    deepLink: 'render',
    authenticatedRedirect: null,
  }),
  about: route({
    path: '/about',
    title: 'About Calibrate',
    parent: 'settings-help',
    fallback: 'settings-help',
    backLabel: 'Back to Help & app',
    authClass: 'authenticated',
    shellPolicy: 'app',
    deepLink: 'render',
    authenticatedRedirect: null,
  }),
  advanced: route({
    path: '/advanced',
    title: 'Advanced settings',
    parent: 'settings-help',
    fallback: 'settings-help',
    backLabel: 'Back to Help & app',
    authClass: 'authenticated',
    shellPolicy: 'app',
    deepLink: 'render',
    authenticatedRedirect: null,
  }),
  'server-admin': route({
    path: '/server-admin',
    title: 'Server administration',
    parent: 'settings',
    fallback: 'settings',
    backLabel: 'Back to Settings',
    authClass: 'authenticated',
    shellPolicy: 'app',
    deepLink: 'render',
    authenticatedRedirect: null,
  }),
  weight: route({
    path: '/weight',
    title: 'Weight entry',
    parent: 'progress',
    fallback: 'progress',
    backLabel: 'Back to Progress',
    authClass: 'authenticated',
    shellPolicy: 'overlay',
    deepLink: 'render',
    authenticatedRedirect: null,
  }),
  'nutrition-label': route({
    path: '/nutrition-label',
    title: 'Scan nutrition label',
    parent: 'my-foods',
    fallback: 'my-foods',
    backLabel: 'Back to Saved foods',
    authClass: 'authenticated',
    shellPolicy: 'standalone',
    deepLink: 'render',
    authenticatedRedirect: null,
  }),
  barcode: route({
    path: '/barcode',
    title: 'Scan barcode',
    parent: 'today',
    fallback: 'today',
    backLabel: 'Back to Today',
    authClass: 'authenticated',
    shellPolicy: 'standalone',
    deepLink: 'render',
    authenticatedRedirect: null,
  }),
} as const satisfies Record<RouteId, RouteDefinition>;

export type RouteMatch = {
  routeId: RouteId;
  definition: RouteDefinition;
  matchedPath: string;
  canonicalPath: string;
  isAlias: boolean;
};

const trimRoutePath = (pathname: string): string => {
  const pathOnly = pathname.split(/[?#]/, 1)[0] ?? '/';
  if (pathOnly === '/') return pathOnly;
  return pathOnly.replace(/\/+$/, '') || '/';
};

export const REGISTERED_ROUTE_PATHS = ROUTE_IDS.flatMap((routeId) => {
  const definition = ROUTE_REGISTRY[routeId];
  return [definition.path, ...definition.aliases.map((alias) => alias.path)];
});

/** Reads the canonical definition for a typed route identifier. */
export function getRouteDefinition(routeId: RouteId): RouteDefinition {
  return ROUTE_REGISTRY[routeId];
}

/** Returns the registered canonical path for a typed route identifier. */
export function canonicalPathForRoute(routeId: RouteId): RouteDefinition['path'] {
  return ROUTE_REGISTRY[routeId].path;
}

/** Matches normalized paths and aliases to their canonical route definition, returning null for unknown paths. */
export function getRouteByPath(pathname: string): RouteMatch | null {
  const matchedPath = trimRoutePath(pathname);
  for (const routeId of ROUTE_IDS) {
    const definition = ROUTE_REGISTRY[routeId];
    if (definition.path === matchedPath) {
      return {
        routeId,
        definition,
        matchedPath,
        canonicalPath: definition.path,
        isAlias: false,
      };
    }
    if (definition.aliases.some((alias) => alias.path === matchedPath)) {
      return {
        routeId,
        definition,
        matchedPath,
        canonicalPath: definition.path,
        isAlias: true,
      };
    }
  }
  return null;
}

/** Tests route identity after alias normalization. */
export function isRouteActive(pathname: string, routeId: RouteId): boolean {
  return getRouteByPath(pathname)?.routeId === routeId;
}

/** Returns the declared parent route or null for a root route. */
export function getRouteParent(routeId: RouteId): RouteDefinition | null {
  const parent = ROUTE_REGISTRY[routeId].parent;
  return parent ? ROUTE_REGISTRY[parent] : null;
}

/** Returns the declared fallback destination or null when none is configured. */
export function getRouteFallback(routeId: RouteId): RouteDefinition | null {
  const fallback = ROUTE_REGISTRY[routeId].fallback;
  return fallback ? ROUTE_REGISTRY[fallback] : null;
}
