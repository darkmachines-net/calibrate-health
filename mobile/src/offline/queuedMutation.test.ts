/** @file Regression coverage for queued Mutation: queued mutation serialization. */

import {
    createOutboxNamespace,
    parseMutationPayload,
    serializeMutationPayload
} from './queuedMutation';

describe('queued mutation serialization', () => {
    it('round-trips nested JSON without changing its replay payload', () => {
        const payload = {
            localDate: '2026-07-11',
            calories: 540,
            servings: [1, 0.5],
            metadata: { provider: null, confirmed: true }
        };

        expect(parseMutationPayload(serializeMutationPayload(payload))).toEqual(payload);
    });

    it.each([
        { value: Number.NaN, message: 'finite' },
        { value: new Date(), message: 'plain JSON objects' },
        { value: undefined, message: 'only JSON values' }
    ])('rejects payload values that JSON would lose: $message', ({ value, message }) => {
        expect(() => serializeMutationPayload({ value })).toThrow(message);
    });

    it('rejects circular payloads', () => {
        const payload: Record<string, unknown> = {};
        payload.self = payload;
        expect(() => serializeMutationPayload(payload)).toThrow('circular');
    });
});

describe('createOutboxNamespace', () => {
    it('uses only the normalized server origin and authenticated user ID', () => {
        expect(createOutboxNamespace('HTTPS://Example.COM:443/api/', 42)).toBe(
            'https://example.com::user:42'
        );
    });

    it('separates accounts and self-hosted origins', () => {
        const first = createOutboxNamespace('https://health.example', 1);
        expect(createOutboxNamespace('https://health.example', 2)).not.toBe(first);
        expect(createOutboxNamespace('https://other.example', 1)).not.toBe(first);
    });

    it('rejects non-http server URLs and empty user IDs', () => {
        expect(() => createOutboxNamespace('file:///tmp/calibrate', 1)).toThrow('http or https');
        expect(() => createOutboxNamespace('https://health.example', ' ')).toThrow('user ID');
    });
});
