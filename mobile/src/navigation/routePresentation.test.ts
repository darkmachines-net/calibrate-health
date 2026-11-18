/** @file Regression coverage for shell back labels and browser history detection. */

import { getRouteBackLabel, hasBrowserHistorySinceMount } from './routePresentation';

describe('route presentation', () => {
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
