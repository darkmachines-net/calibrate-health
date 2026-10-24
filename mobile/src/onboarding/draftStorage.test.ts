/** @file Regression coverage for draft Storage: onboarding draft storage. */

const mockValues = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
    __esModule: true,
    default: {
        getItem: jest.fn(async (key: string) => mockValues.get(key) ?? null),
        setItem: jest.fn(async (key: string, value: string) => { mockValues.set(key, value); }),
        removeItem: jest.fn(async (key: string) => { mockValues.delete(key); })
    }
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { UserClientPayload } from '@calibrate/api-client';
import { createInitialOnboardingForm } from './completionState';
import {
    bindOnboardingDraft, clearOnboardingDraft, onboardingDraftStorageKey,
    readOnboardingDraft, writeOnboardingDraft, type OnboardingDraft
} from './draftStorage';

const SERVER = 'https://health.example';
const DRAFT: OnboardingDraft = {
    version: 1,
    step: 'plan',
    form: { ...createInitialOnboardingForm({ id: 7, timezone: 'UTC' } as UserClientPayload), currentWeight: '80.', dailyChangeAbs: '' }
};

describe('onboarding draft storage', () => {
    beforeEach(() => { mockValues.clear(); jest.clearAllMocks(); });

    it('restores incomplete input and isolates accounts and server origins', async () => {
        const binding = bindOnboardingDraft(SERVER, 7);
        await writeOnboardingDraft(binding, DRAFT);
        expect(await readOnboardingDraft(bindOnboardingDraft('HTTPS://HEALTH.EXAMPLE:443/', 7))).toEqual(DRAFT);
        expect(await readOnboardingDraft(bindOnboardingDraft(SERVER, 8))).toBeNull();
        expect(await readOnboardingDraft(bindOnboardingDraft('https://other.example', 7))).toBeNull();
    });

    it.each(['{broken', JSON.stringify({ ...DRAFT, version: 2 }), JSON.stringify({ ...DRAFT, form: {} }), JSON.stringify({ ...DRAFT, step: 'watch' })])(
        'discards malformed or incompatible drafts', async (encoded) => {
            const binding = bindOnboardingDraft(SERVER, 7);
            mockValues.set(binding.key, encoded);
            expect(await readOnboardingDraft(binding)).toBeNull();
            expect(mockValues.has(binding.key)).toBe(false);
        }
    );

    it('clears an in-flight save and rejects later saves from its invalidated binding', async () => {
        const binding = bindOnboardingDraft(SERVER, 7);
        let releaseWrite!: () => void;
        let markStarted!: () => void;
        const started = new Promise<void>((resolve) => { markStarted = resolve; });
        jest.mocked(AsyncStorage.setItem).mockImplementationOnce(async (key, value) => {
            markStarted();
            await new Promise<void>((resolve) => { releaseWrite = resolve; });
            mockValues.set(key, value);
        });
        const write = writeOnboardingDraft(binding, DRAFT);
        await started;
        const clear = clearOnboardingDraft(SERVER, 7);
        const staleWrite = writeOnboardingDraft(binding, DRAFT);
        releaseWrite();
        await Promise.all([write, clear, staleWrite]);
        expect(mockValues.has(binding.key)).toBe(false);
        await writeOnboardingDraft(bindOnboardingDraft(SERVER, 7), DRAFT);
        expect(mockValues.has(onboardingDraftStorageKey(SERVER, 7))).toBe(true);
    });

    it('continues processing after a failed storage operation', async () => {
        const binding = bindOnboardingDraft(SERVER, 7);
        jest.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('Storage unavailable'));
        await expect(writeOnboardingDraft(binding, DRAFT)).rejects.toThrow();
        await writeOnboardingDraft(binding, DRAFT);
        expect(await readOnboardingDraft(binding)).toEqual(DRAFT);
    });
});
