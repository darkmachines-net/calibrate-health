/** @file Regression coverage for presentation: privacy-safe error presentation. */

import { ApiError } from '@calibrate/api-client';
import { getErrorPresentation, getSafeActionErrorMessage } from './presentation';

describe('privacy-safe error presentation', () => {
    it('never relays server, provider, SQL, or stack text', () => {
        for (const raw of [
            'FatSecret token rejected',
            'SELECT password_hash FROM users',
            'Error: boom\n    at private/service.ts:12'
        ]) {
            const error = new ApiError(raw, 500, {
                message: raw,
                code: 'SERVER_ERROR',
                retryable: true,
                request_id: 'safe-reference'
            });
            const presentation = getErrorPresentation(error, 'saved foods');
            expect(`${presentation.title} ${presentation.message}`).not.toContain(raw);
            expect(presentation.requestId).toBe('safe-reference');
            expect(getSafeActionErrorMessage(error, 'Unable to save.')).toBe('Unable to save.');
        }
    });

    it('maps network and authorization failures to actionable bounded copy', () => {
        expect(getErrorPresentation(new TypeError('Network request failed'), 'progress').message)
            .toMatch(/connection/i);
        expect(getErrorPresentation(new ApiError('raw', 403, null), 'profile').message)
            .toMatch(/does not have access/i);
    });
});
