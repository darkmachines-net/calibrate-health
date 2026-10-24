/** @file Regression coverage for client Diagnostics: client diagnostics reporter. */

jest.mock('expo-application', () => ({
    nativeApplicationVersion: '0.2.6'
}));

import { Platform } from 'react-native';
import { ApiError } from '@calibrate/api-client';
import release from '../../../shared/release.json';
import { MOBILE_CLIENT_IDENTITY } from '../config/nativeClient';
import {
    getClientDiagnosticRequestId,
    registerClientDiagnosticReporter,
    reportClientDiagnostic,
    type ClientDiagnosticSignal,
    type ClientDiagnosticWireInput
} from './clientDiagnostics';

const ROOT_SIGNAL: ClientDiagnosticSignal = {
    event: 'client_failure',
    operation: 'root_render',
    route: 'app_shell',
    outcome: 'failure',
    duration_bucket: 'not_applicable',
    request_id: '123e4567-e89b-42d3-a456-426614174000'
};
const RETRY_ROOT_SIGNAL: ClientDiagnosticSignal = {
    ...ROOT_SIGNAL,
    request_id: '223e4567-e89b-42d3-a456-426614174001'
};
const FEATURE_SIGNAL: ClientDiagnosticSignal = {
    event: 'operation_failure',
    operation: 'food_copy',
    route: 'today',
    outcome: 'failure',
    duration_bucket: 'not_applicable'
};

const SENSITIVE_ALIASES = [
    'email',
    'food_name',
    'weight_kg',
    'health_data',
    'url',
    'query_string',
    'access_token',
    'stack_trace',
    'payload',
    'context',
    'authorization',
    'requestId'
] as const;

function createSensitivePropertyCases(seed: number, count: number): Array<{
    alias: (typeof SENSITIVE_ALIASES)[number];
    value: string;
}> {
    let state = seed >>> 0;
    const next = () => {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        return state;
    };
    const valueFactories = [
        (value: number) => `sensitive.user.${value}@example.invalid`,
        (value: number) => `Food diary ${value}: peanut butter`,
        (value: number) => `Weight ${value % 300}.4 kg`,
        (value: number) => `Blood glucose ${value % 200} mg/dL`,
        (value: number) => `https://private.example/users/${value}?email=person@example.com&token=secret`,
        (value: number) => `?search=food-${value}&authorization=private-${value.toString(16)}`,
        (value: number) => `Bearer secret-token-${value.toString(16)}`,
        (value: number) => `AliceWeight${value.toString(16)}`,
        (value: number) => `health.token-${value.toString(16)}`,
        (value: number) => `Error: private-${value}\n    at Profile (C:\\Users\\Person\\health.ts:1:1)`
    ];

    return Array.from({ length: count }, () => {
        const valueSeed = next();
        const alias = SENSITIVE_ALIASES[valueSeed % SENSITIVE_ALIASES.length];
        const makeValue = valueFactories[(valueSeed >>> 8) % valueFactories.length];
        return { alias, value: makeValue(valueSeed) };
    });
}

const SENSITIVE_PROPERTY_CASES = createSensitivePropertyCases(0x5eedc0de, 96);

describe('client diagnostics reporter', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('adds only the canonical web identity to the fixed signal', async () => {
        jest.replaceProperty(Platform, 'OS', 'web');
        const reporter = jest.fn(async (input) => ({ ok: true as const, request_id: input.request_id! }));
        const unregister = registerClientDiagnosticReporter(reporter);

        await expect(reportClientDiagnostic(ROOT_SIGNAL)).resolves.toBe(ROOT_SIGNAL.request_id);
        expect(reporter).toHaveBeenCalledWith({
            ...ROOT_SIGNAL,
            platform: 'web',
            version: release.server.version
        });

        unregister();
    });

    it('adds the canonical iOS identity to native signals', async () => {
        jest.replaceProperty(Platform, 'OS', 'ios');
        const reporter = jest.fn(async (input) => ({ ok: true as const, request_id: input.request_id! }));
        const unregister = registerClientDiagnosticReporter(reporter);

        await expect(reportClientDiagnostic(ROOT_SIGNAL)).resolves.toBe(ROOT_SIGNAL.request_id);
        expect(reporter).toHaveBeenCalledWith({
            ...ROOT_SIGNAL,
            platform: 'ios',
            version: MOBILE_CLIENT_IDENTITY.version
        });

        unregister();
    });

    it('retains the latest deferred root until a confirmed reporter accepts it', async () => {
        jest.replaceProperty(Platform, 'OS', 'web');
        await expect(reportClientDiagnostic(ROOT_SIGNAL)).resolves.toBeNull();
        await expect(reportClientDiagnostic(RETRY_ROOT_SIGNAL)).resolves.toBeNull();

        const failedReporter = jest.fn(async () => ({
            ok: true as const,
            request_id: 'AliceWeight'
        }));
        const unregisterFailed = registerClientDiagnosticReporter(failedReporter);
        await Promise.resolve();
        await Promise.resolve();
        expect(failedReporter).toHaveBeenCalledTimes(1);
        expect(failedReporter).toHaveBeenCalledWith({
            ...RETRY_ROOT_SIGNAL,
            platform: 'web',
            version: release.server.version
        });
        unregisterFailed();

        const reporter = jest.fn(async (input: ClientDiagnosticWireInput) => ({
            ok: true as const,
            request_id: input.request_id!
        }));
        const unregister = registerClientDiagnosticReporter(reporter);
        await Promise.resolve();
        expect(reporter).toHaveBeenCalledTimes(1);
        expect(reporter).toHaveBeenCalledWith({
            ...RETRY_ROOT_SIGNAL,
            platform: 'web',
            version: release.server.version
        });
        unregister();

        const laterReporter = jest.fn(async (input: ClientDiagnosticWireInput) => ({
            ok: true as const,
            request_id: input.request_id!
        }));
        const unregisterLater = registerClientDiagnosticReporter(laterReporter);
        await Promise.resolve();
        expect(laterReporter).not.toHaveBeenCalled();
        unregisterLater();
    });

    it('never admits generated user or health properties into the fixed wire tuple', async () => {
        jest.replaceProperty(Platform, 'OS', 'web');
        const reporter = jest.fn(async (input) => ({ ok: true as const, request_id: input.request_id! }));
        const unregister = registerClientDiagnosticReporter(reporter);
        const expectedWireInput = {
            event: ROOT_SIGNAL.event,
            operation: ROOT_SIGNAL.operation,
            route: ROOT_SIGNAL.route,
            platform: 'web',
            version: release.server.version,
            outcome: ROOT_SIGNAL.outcome,
            duration_bucket: ROOT_SIGNAL.duration_bucket,
            request_id: ROOT_SIGNAL.request_id
        };

        for (const propertyCase of SENSITIVE_PROPERTY_CASES) {
            await reportClientDiagnostic({
                ...ROOT_SIGNAL,
                [propertyCase.alias]: propertyCase.value
            } as ClientDiagnosticSignal);
        }

        expect(reporter).toHaveBeenCalledTimes(SENSITIVE_PROPERTY_CASES.length);
        for (const [wireInput] of reporter.mock.calls) {
            expect(wireInput).toEqual(expectedWireInput);
            expect(Object.keys(wireInput)).toEqual(Object.keys(expectedWireInput));
        }

        const serializedWireInputs = JSON.stringify(reporter.mock.calls);
        for (const propertyCase of SENSITIVE_PROPERTY_CASES) {
            expect(serializedWireInputs).not.toContain(propertyCase.alias);
            expect(serializedWireInputs).not.toContain(propertyCase.value);
        }

        unregister();
    });

    it('omits generated sensitive values masquerading as request IDs', async () => {
        jest.replaceProperty(Platform, 'OS', 'web');
        const reporter = jest.fn(async (_input: ClientDiagnosticWireInput) => ({
            ok: true as const,
            request_id: ROOT_SIGNAL.request_id!
        }));
        const unregister = registerClientDiagnosticReporter(reporter);
        const expectedWireInput = {
            event: ROOT_SIGNAL.event,
            operation: ROOT_SIGNAL.operation,
            route: ROOT_SIGNAL.route,
            platform: 'web',
            version: release.server.version,
            outcome: ROOT_SIGNAL.outcome,
            duration_bucket: ROOT_SIGNAL.duration_bucket
        };

        const broadButNonOpaqueIds = SENSITIVE_PROPERTY_CASES.filter(({ value }) => (
            /^[A-Za-z0-9._:-]{1,128}$/u.test(value)
        ));
        expect(broadButNonOpaqueIds.length).toBeGreaterThan(0);

        for (const propertyCase of SENSITIVE_PROPERTY_CASES) {
            await reportClientDiagnostic({
                ...ROOT_SIGNAL,
                request_id: propertyCase.value
            });
        }

        expect(reporter).toHaveBeenCalledTimes(SENSITIVE_PROPERTY_CASES.length);
        for (const [wireInput] of reporter.mock.calls) {
            expect(wireInput).toEqual(expectedWireInput);
            expect(Object.keys(wireInput)).toEqual(Object.keys(expectedWireInput));
        }

        unregister();
    });

    it('does not emit on an unsupported platform or without a registered transport', async () => {
        jest.replaceProperty(Platform, 'OS', 'windows');
        const reporter = jest.fn(async () => ({ ok: true as const, request_id: 'unused' }));
        const unregister = registerClientDiagnosticReporter(reporter);

        await expect(reportClientDiagnostic(ROOT_SIGNAL)).resolves.toBeNull();
        expect(reporter).not.toHaveBeenCalled();
        unregister();

        jest.replaceProperty(Platform, 'OS', 'web');
        await expect(reportClientDiagnostic(FEATURE_SIGNAL)).resolves.toBeNull();
    });

    it('swallows transport failures without logging their potentially sensitive message', async () => {
        jest.replaceProperty(Platform, 'OS', 'web');
        const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const reporter = jest.fn(async () => {
            throw new Error('person@example.com at https://private.example/path?token=secret');
        });
        const unregister = registerClientDiagnosticReporter(reporter);

        await expect(reportClientDiagnostic(ROOT_SIGNAL)).resolves.toBeNull();
        expect(consoleError).not.toHaveBeenCalled();
        expect(consoleWarn).not.toHaveBeenCalled();

        unregister();
    });

    it('extracts only the API client bounded request ID', () => {
        const error = new ApiError('private provider failure', 500, {
            message: 'private provider failure',
            request_id: 'abcdef0123456789'
        });
        const broadButNonOpaque = new ApiError('private provider failure', 500, {
            message: 'private provider failure',
            request_id: 'AliceWeight'
        });

        expect(getClientDiagnosticRequestId(error)).toBe('abcdef0123456789');
        expect(getClientDiagnosticRequestId(broadButNonOpaque)).toBeUndefined();
        expect(getClientDiagnosticRequestId(new Error('person@example.com'))).toBeUndefined();
    });
});
