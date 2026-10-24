/** @file Canonical route metadata resolution, authenticated-root behavior, and privacy-aware browser metadata. */

import { ROUTE_IDS, getRouteByPath, getRouteDefinition, type RouteId } from './routeRegistry';
import webRouteMetadata from '../../../shared/webRouteMetadata.json';

export const ROUTE_ROBOTS_POLICIES = {
    PUBLIC: 'index, follow',
    PRIVATE: 'noindex, nofollow'
} as const;

export type RouteMetadata = Readonly<{
    title: string;
    description: string;
    canonicalPath: string | null;
    robots: (typeof ROUTE_ROBOTS_POLICIES)[keyof typeof ROUTE_ROBOTS_POLICIES];
}>;

const NOT_FOUND_DESCRIPTION = 'The requested Calibrate page could not be found.';

const PUBLIC_INDEXABLE_ROUTES = new Set<RouteId>([
    'root',
    'terms',
    'support',
    'privacy',
    'account-deletion',
    'health-connect-privacy'
]);

const PUBLIC_DESCRIPTIONS: Partial<Record<RouteId, string>> = {
    terms: 'Read the terms that govern use of the Calibrate food, weight, activity, and goal tracking service.',
    support: 'Find Calibrate support information, troubleshooting guidance, and ways to get help.',
    privacy: 'Learn how Calibrate handles account, food, weight, activity, and technical information.',
    'account-deletion': 'Learn how to delete a Calibrate account and what happens to associated tracking data.',
    'health-connect-privacy': 'Learn how Calibrate reads, uses, stores, and deletes Health Connect activity data.'
};

function descriptionForRoute(routeId: RouteId): string {
    const publicDescription = PUBLIC_DESCRIPTIONS[routeId];
    if (publicDescription) return publicDescription;
    const definition = getRouteDefinition(routeId);
    return `${definition.title} in Calibrate, your private food, weight, activity, and goal tracker.`;
}

/** Resolves canonical metadata and privacy policy, including authenticated-root and unknown-route handling. */
export function resolveRouteMetadata(
    pathname: string,
    options: { authenticated: boolean }
): RouteMetadata {
    const match = getRouteByPath(pathname);
    if (!match) {
        return {
            title: 'Page not found - Calibrate',
            description: NOT_FOUND_DESCRIPTION,
            canonicalPath: null,
            robots: ROUTE_ROBOTS_POLICIES.PRIVATE
        };
    }

    // Authenticated root is a transient redirect to Today; expose the destination metadata immediately.
    const routeId = match.routeId === 'root' && options.authenticated ? 'today' : match.routeId;
    if (routeId === 'root') {
        return {
            title: webRouteMetadata.landing.title,
            description: webRouteMetadata.landing.description,
            canonicalPath: webRouteMetadata.landing.canonicalPath,
            robots: webRouteMetadata.landing.robots as RouteMetadata['robots']
        };
    }

    const definition = getRouteDefinition(routeId);
    return {
        title: definition.documentTitle,
        description: descriptionForRoute(routeId),
        canonicalPath: definition.path,
        robots: PUBLIC_INDEXABLE_ROUTES.has(routeId)
            ? ROUTE_ROBOTS_POLICIES.PUBLIC
            : ROUTE_ROBOTS_POLICIES.PRIVATE
    };
}

/** Lists metadata for canonical routes using their public, unauthenticated presentation. */
export function getCanonicalRouteMetadata(): RouteMetadata[] {
    return ROUTE_IDS.map((routeId) => resolveRouteMetadata(
        getRouteDefinition(routeId).path,
        { authenticated: false }
    ));
}
