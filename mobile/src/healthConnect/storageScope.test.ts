/** @file Regression coverage for storage Scope: Health Connect storage scope. */

import {
    canonicalHealthConnectServerIdentity,
    healthConnectAccountScope
} from './storageScope';

describe('Health Connect storage scope', () => {
    it('canonicalizes equivalent origins and isolates different self-hosted servers', () => {
        expect(canonicalHealthConnectServerIdentity('HTTPS://Health.Example.com:443/path/'))
            .toBe('https://health.example.com');
        expect(healthConnectAccountScope('https://health.example.com/', 1))
            .toBe(healthConnectAccountScope('HTTPS://HEALTH.EXAMPLE.COM:443', 1));
        expect(healthConnectAccountScope('https://one.example.com', 1))
            .not.toBe(healthConnectAccountScope('https://two.example.com', 1));
    });
});
