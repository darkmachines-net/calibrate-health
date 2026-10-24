/** @file route matrix: Browser expectations generated from the same registry used by the app shell. */

import {
  ROUTE_IDS,
  ROUTE_REGISTRY,
  canonicalPathForRoute,
  type RouteAlias,
  type RouteId,
} from '../../mobile/src/navigation/routeRegistry';

type RouteAuthentication = 'public' | 'signed-out-only' | 'authenticated';
type DeepLinkBehavior = 'render' | 'session-redirect' | 'alias-redirect';

export type RouteExpectation = {
  path: string;
  authentication: RouteAuthentication;
  deepLink: DeepLinkBehavior;
  signedOutPath: string;
  authenticatedPath: string;
  reload: 'preserve' | 'preserve-redirect';
  historyFallback: string | null;
};

const destinationPath = (routeId: RouteId): string => canonicalPathForRoute(routeId);

const expectationForCanonicalRoute = (routeId: RouteId): RouteExpectation => {
  const definition = ROUTE_REGISTRY[routeId];
  const signedOutPath = definition.authClass === 'authenticated'
    ? canonicalPathForRoute('login')
    : definition.path;
  const authenticatedPath = definition.authenticatedRedirect
    ? destinationPath(definition.authenticatedRedirect)
    : definition.path;

  return {
    path: definition.path,
    authentication: definition.authClass,
    deepLink: definition.deepLink,
    signedOutPath,
    authenticatedPath,
    reload: definition.deepLink === 'render' ? 'preserve' : 'preserve-redirect',
    historyFallback: definition.fallback ? destinationPath(definition.fallback) : null,
  };
};

const expectationForAlias = (
  routeId: RouteId,
  alias: RouteAlias,
): RouteExpectation => {
  const definition = ROUTE_REGISTRY[routeId];
  return {
    path: alias.path,
    authentication: definition.authClass,
    deepLink: 'alias-redirect',
    signedOutPath: definition.authClass === 'authenticated'
      ? canonicalPathForRoute('login')
      : alias.path,
    authenticatedPath: destinationPath(alias.authenticatedRedirect),
    reload: 'preserve-redirect',
    historyFallback: null,
  };
};

/** Browser expectations generated from the same registry used by the app shell. */
export const ROUTE_MATRIX: readonly RouteExpectation[] = [
  ...ROUTE_IDS.map(expectationForCanonicalRoute),
  ...ROUTE_IDS.flatMap((routeId) => (
    ROUTE_REGISTRY[routeId].aliases.map((alias) => expectationForAlias(routeId, alias))
  )),
];

const PUBLIC_HEADING_ROUTE_IDS = [
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
] as const satisfies readonly RouteId[];

export const PUBLIC_ROUTE_HEADINGS: Readonly<Record<string, string>> = Object.fromEntries(
  PUBLIC_HEADING_ROUTE_IDS.map((routeId) => [
    canonicalPathForRoute(routeId),
    ROUTE_REGISTRY[routeId].title,
  ]),
);
