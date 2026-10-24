/** @file Regression coverage for auth Server Draft: readAuthServerDraft. */

import { readAuthServerDraft } from './authServerDraft';

describe('readAuthServerDraft', () => {
    it('preserves a server carried between auth routes', () => {
        expect(readAuthServerDraft('http://127.0.0.1:3300')).toBe('http://127.0.0.1:3300');
    });

    it('uses the first Expo Router value and ignores blank drafts', () => {
        expect(readAuthServerDraft(['https://first.example', 'https://second.example']))
            .toBe('https://first.example');
        expect(readAuthServerDraft('   ')).toBeNull();
        expect(readAuthServerDraft(undefined)).toBeNull();
    });
});
