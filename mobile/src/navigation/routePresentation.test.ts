/** @file Regression coverage for route Presentation: route presentation. */

import {
    getRouteBackLabel,
    getRouteDocumentTitle,
    hasBrowserHistorySinceMount,
    NOT_FOUND_DOCUMENT_TITLE
} from './routePresentation';

describe('route presentation', () => {
    it('uses registered document titles for canonical routes and aliases', () => {
        expect(getRouteDocumentTitle('/weight-trend')).toBe('Trend - Calibrate');
        expect(getRouteDocumentTitle('/log')).toBe('Today - Calibrate');
    });

    it('uses the not-found title for unknown paths', () => {
        expect(getRouteDocumentTitle('/missing')).toBe(NOT_FOUND_DOCUMENT_TITLE);
    });

    it('describes real history generically and a direct-entry fallback by parent', () => {
        expect(getRouteBackLabel('/activity', true)).toBe('Go back');
        expect(getRouteBackLabel('/activity', false)).toBe('Back to Connections');
        expect(getRouteBackLabel('/profile', false)).toBe('Back to Settings');
        expect(getRouteBackLabel('/my-foods', false)).toBe('Back to Data & privacy');
        expect(getRouteBackLabel('/about', false)).toBe('Back to Help & app');
        expect(getRouteBackLabel('/advanced', false)).toBe('Back to Help & app');
        expect(getRouteBackLabel('/today', true)).toBeNull();
    });

    it('distinguishes history added after the authenticated shell mounted', () => {
        expect(hasBrowserHistorySinceMount(2, 3)).toBe(true);
        expect(hasBrowserHistorySinceMount(2, 2)).toBe(false);
        expect(hasBrowserHistorySinceMount(3, 2)).toBe(false);
    });
});
