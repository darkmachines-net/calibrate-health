/** @file Regression coverage for route Metadata: route metadata. */

import { ROUTE_IDS, getRouteDefinition } from './routeRegistry';
import {
    ROUTE_ROBOTS_POLICIES,
    getCanonicalRouteMetadata,
    resolveRouteMetadata
} from './routeMetadata';

describe('route metadata', () => {
    it('distinguishes the public landing page from authenticated root redirect metadata', () => {
        expect(resolveRouteMetadata('/', { authenticated: false })).toEqual({
            title: 'Calibrate - Private calorie tracking',
            description: expect.stringMatching(/private Calibrate account/i),
            canonicalPath: '/',
            robots: ROUTE_ROBOTS_POLICIES.PUBLIC
        });
        expect(resolveRouteMetadata('/', { authenticated: true })).toMatchObject({
            title: 'Today - Calibrate',
            canonicalPath: '/today',
            robots: ROUTE_ROBOTS_POLICIES.PRIVATE
        });
    });

    it('gives every canonical route a non-empty unique title and description', () => {
        const metadata = getCanonicalRouteMetadata();
        expect(metadata).toHaveLength(ROUTE_IDS.length);
        expect(new Set(metadata.map((entry) => entry.title)).size).toBe(metadata.length);
        expect(new Set(metadata.map((entry) => entry.description)).size).toBe(metadata.length);
        metadata.forEach((entry) => {
            expect(entry.title.trim()).not.toBe('');
            expect(entry.description.trim()).not.toBe('');
        });
    });

    it('canonicalizes aliases and keeps private/authentication routes out of search indexes', () => {
        expect(resolveRouteMetadata('/log?date=2026-08-09', { authenticated: true })).toMatchObject({
            canonicalPath: '/today',
            robots: ROUTE_ROBOTS_POLICIES.PRIVATE
        });
        expect(resolveRouteMetadata('/login', { authenticated: false }).robots).toBe(ROUTE_ROBOTS_POLICIES.PRIVATE);
        expect(resolveRouteMetadata('/privacy', { authenticated: false }).robots).toBe(ROUTE_ROBOTS_POLICIES.PUBLIC);
    });

    it.each(['/missing', '/notifications'])('does not invent a canonical URL for unknown route %s', (pathname) => {
        expect(resolveRouteMetadata(pathname, { authenticated: false })).toEqual({
            title: 'Page not found - Calibrate',
            description: 'The requested Calibrate page could not be found.',
            canonicalPath: null,
            robots: ROUTE_ROBOTS_POLICIES.PRIVATE
        });
    });

    it('keeps canonical metadata origin-relative for hosted and self-hosted deployments', () => {
        for (const routeId of ROUTE_IDS) {
            const metadata = resolveRouteMetadata(getRouteDefinition(routeId).path, { authenticated: false });
            if (metadata.canonicalPath !== null) expect(metadata.canonicalPath).toMatch(/^\//);
            expect(metadata.canonicalPath).not.toMatch(/^https?:/);
        }
    });
});
