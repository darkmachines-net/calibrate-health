/** @file Regression coverage for use Onboarding Draft: useOnboardingDraft. */

const mockValues = new Map<string, string>();
let mockMeasurementSystem: 'metric' | 'us' = 'metric';
jest.mock('../platform/deviceLocale', () => ({ getDeviceLocale: () => ({ languageTag: 'en-US', regionCode: 'US', measurementSystem: mockMeasurementSystem }) }));
jest.mock('@react-native-async-storage/async-storage', () => ({
    __esModule: true,
    default: {
        getItem: jest.fn(async (key: string) => mockValues.get(key) ?? null),
        setItem: jest.fn(async (key: string, value: string) => { mockValues.set(key, value); }),
        removeItem: jest.fn(async (key: string) => { mockValues.delete(key); })
    }
}));

import { act, renderHook, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { UserClientPayload } from '@calibrate/api-client';
import { createInitialOnboardingForm } from './completionState';
import { onboardingDraftStorageKey } from './draftStorage';
import { useOnboardingDraft } from './useOnboardingDraft';

const SERVER = 'https://health.example';
const USER = { id: 7, timezone: 'UTC' } as UserClientPayload;

describe('useOnboardingDraft', () => {
    beforeEach(() => { mockValues.clear(); jest.clearAllMocks(); mockMeasurementSystem = 'metric'; });

    it('restores entered fields and step after remount, without reinitializing for a refreshed user', async () => {
        const first = await renderHook(({ user }: { user: UserClientPayload }) => useOnboardingDraft({ serverUrl: SERVER, user }), { initialProps: { user: USER } });
        await waitFor(() => expect(first.result.current.isHydrating).toBe(false));
        await act(() => {
            first.result.current.setForm((form) => ({ ...form, currentWeight: '80.', dailyChangeAbs: '' }));
            first.result.current.setStep('plan');
        });
        await waitFor(() => expect(JSON.parse(mockValues.get(onboardingDraftStorageKey(SERVER, USER.id))!).step).toBe('plan'));
        await first.rerender({ user: { ...USER, sex: 'FEMALE' } });
        expect(first.result.current.form.currentWeight).toBe('80.');
        await first.unmount();
        const second = await renderHook(() => useOnboardingDraft({ serverUrl: SERVER, user: USER }));
        await waitFor(() => expect(second.result.current.isHydrating).toBe(false));
        expect(second.result.current.form.currentWeight).toBe('80.');
        expect(second.result.current.form.dailyChangeAbs).toBe('');
        expect(second.result.current.step).toBe('plan');
    });

    it('restores both draft unit choices even after device preferences change', async () => {
        const key = onboardingDraftStorageKey(SERVER, USER.id);
        mockValues.set(key, JSON.stringify({ version: 1, step: 'activity', form: {
            ...createInitialOnboardingForm(USER), weightUnit: 'LB', heightUnit: 'CM'
        } }));
        mockMeasurementSystem = 'us';
        const { result } = await renderHook(() => useOnboardingDraft({ serverUrl: SERVER, user: USER }));
        await waitFor(() => expect(result.current.isHydrating).toBe(false));
        expect(result.current.form.weightUnit).toBe('LB');
        expect(result.current.form.heightUnit).toBe('CM');
    });

    it('does not overwrite stored data with defaults while hydration is pending', async () => {
        let resolveRead!: (value: string) => void;
        jest.mocked(AsyncStorage.getItem).mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }));
        const { result } = await renderHook(() => useOnboardingDraft({ serverUrl: SERVER, user: USER }));
        await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
        expect(result.current.isHydrating).toBe(true);
        expect(AsyncStorage.setItem).not.toHaveBeenCalled();
        await act(async () => resolveRead(JSON.stringify({ version: 1, step: 'activity', form: { ...createInitialOnboardingForm(USER), currentWeight: '75' } })));
        expect(result.current.form.currentWeight).toBe('75');
    });

    it('ignores a delayed previous-account read and immediately hides its form', async () => {
        let resolveRead!: (value: string) => void;
        jest.mocked(AsyncStorage.getItem).mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }));
        const { result, rerender } = await renderHook(({ user }: { user: UserClientPayload }) => useOnboardingDraft({ serverUrl: SERVER, user }), { initialProps: { user: USER } });
        await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
        await rerender({ user: { ...USER, id: 8 } });
        await waitFor(() => expect(result.current.isHydrating).toBe(false));
        await act(async () => resolveRead(JSON.stringify({ version: 1, step: 'plan', form: { ...createInitialOnboardingForm(USER), currentWeight: '75' } })));
        expect(result.current.form.currentWeight).toBe('');
        expect(result.current.step).toBe('about');
    });

    it('keeps a cleared draft deleted even if a mounted form changes afterward', async () => {
        const { result } = await renderHook(() => useOnboardingDraft({ serverUrl: SERVER, user: USER }));
        await waitFor(() => expect(result.current.isHydrating).toBe(false));
        await act(async () => result.current.clearDraft());
        await act(() => result.current.setStep('plan'));
        await act(async () => undefined);
        expect(mockValues.has(onboardingDraftStorageKey(SERVER, USER.id))).toBe(false);
    });

    it('clears stale drafts for completed users without saving a new one', async () => {
        const key = onboardingDraftStorageKey(SERVER, USER.id);
        mockValues.set(key, JSON.stringify({ version: 1, step: 'plan', form: createInitialOnboardingForm(USER) }));
        await renderHook(() => useOnboardingDraft({ serverUrl: SERVER, user: { ...USER, onboarding_completed_at: '2026-09-25T00:00:00Z' } }));
        await waitFor(() => expect(mockValues.has(key)).toBe(false));
        expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    });

    it('allows setup to continue when local storage cannot be read', async () => {
        jest.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error('Storage unavailable'));
        const { result } = await renderHook(() => useOnboardingDraft({ serverUrl: SERVER, user: USER }));
        await waitFor(() => expect(result.current.isHydrating).toBe(false));
        expect(result.current.storageError).toContain('You can still finish setup');
        expect(AsyncStorage.setItem).not.toHaveBeenCalled();
        await act(() => result.current.setForm((form) => ({ ...form, currentWeight: '80' })));
        expect(result.current.form.currentWeight).toBe('80');
    });
});
