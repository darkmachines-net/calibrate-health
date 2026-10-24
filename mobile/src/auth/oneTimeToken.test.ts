/** @file Regression coverage for one Time Token: consumeOneTimeToken. */

import { consumeOneTimeToken } from './oneTimeToken';

describe('consumeOneTimeToken', () => {
    it('prefers a fragment token and removes every token from the visible URL', () => {
        const replaceState = jest.fn();
        const token = consumeOneTimeToken('router-copy', {
            location: {
                pathname: '/reset-password',
                search: '?token=query-secret&source=email',
                hash: '#token=fragment-secret'
            },
            history: { state: { key: 'test' }, replaceState }
        });

        expect(token).toBe('fragment-secret');
        expect(replaceState).toHaveBeenCalledWith(
            { key: 'test' },
            '',
            '/reset-password?source=email'
        );
    });


    it('uses the routed token on native without durable storage', () => {
        expect(consumeOneTimeToken(['native-secret'], null)).toBe('native-secret');
    });

    it('parses Expo Router native fragment parameters from the # key', () => {
        expect(consumeOneTimeToken(undefined, undefined, 'token=android-secret&source=email'))
            .toBe('android-secret');
    });
});
