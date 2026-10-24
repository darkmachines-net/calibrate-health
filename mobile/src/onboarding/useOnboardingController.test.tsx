/** @file Regression coverage for use Onboarding Controller: onboarding controller. */

import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { notifyManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError, type CaloriePlanOptionsResponse, type UserClientPayload } from '@calibrate/api-client';
import * as Crypto from 'expo-crypto';
import { router } from 'expo-router';
import type { OnboardingFormState } from './completionState';
import type { OnboardingDraftStep } from './draftStorage';

let mockInitialForm: OnboardingFormState;
let mockInitialStep: OnboardingDraftStep = 'plan';
let mockIsOnline = true;
let mockServerUrl = 'https://health.example';
const mockClearDraft = jest.fn(async () => undefined);
const mockUpdateCurrentUser = jest.fn();
const mockApi = { getCaloriePlanOptions: jest.fn(), completeOnboarding: jest.fn() };
jest.mock('../auth/AuthContext', () => ({
    useAuth: () => ({ api: mockApi, serverUrl: mockServerUrl, updateCurrentUser: mockUpdateCurrentUser })
}));
jest.mock('../components/AsyncStateBoundary', () => ({ useOnlineStatus: () => mockIsOnline }));
jest.mock('../diagnostics/operationDiagnostics', () => ({ reportClientOperationFailure: jest.fn() }));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));
jest.mock('expo-router', () => ({ router: { replace: jest.fn() } }));
jest.mock('./useOnboardingDraft', () => {
    const ReactActual = jest.requireActual<typeof React>('react');
    return {
        useOnboardingDraft: () => {
            const [form, setForm] = ReactActual.useState(mockInitialForm);
            const [step, setStep] = ReactActual.useState(mockInitialStep);
            return { form, setForm, step, setStep, isHydrating: false, storageError: null, clearDraft: mockClearDraft };
        }
    };
});

import { useOnboardingController } from './useOnboardingController';
import { reportClientOperationFailure } from '../diagnostics/operationDiagnostics';

const USER = { id: 7, timezone: 'UTC' } as UserClientPayload;
const COMPLETED_USER = { ...USER, onboarding_completed_at: '2026-09-25T00:00:00Z' };
const FORM: OnboardingFormState = {
    weightUnit: 'KG', heightUnit: 'CM', timezone: 'UTC', dateOfBirth: '1990-06-15', sex: 'FEMALE',
    activityLevel: 'MODERATE', currentWeight: '80', currentWeightGrams: 80000,
    targetWeight: '70', targetWeightGrams: 70000, heightCm: '168', heightFeet: '5', heightInches: '6',
    heightMillimeters: 1680, goalMode: 'lose', dailyChangeAbs: '500'
};
const OPTIONS: CaloriePlanOptionsResponse = {
    eligibility: { status: 'eligible', reasonCode: null, ageYears: 36, localDate: '2026-09-25' },
    bmr: 1500, tdee: 2300, minimumDailyCalorieTarget: 1500,
    planOptions: [
        { dailyDeficit: 0, available: true, dailyCalorieTarget: 2300, reasonCode: null },
        { dailyDeficit: 250, available: true, dailyCalorieTarget: 2050, reasonCode: null },
        { dailyDeficit: 500, available: true, dailyCalorieTarget: 1800, reasonCode: null }
    ]
};

async function renderController() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
    const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    return { ...await renderHook(({ user }: { user: UserClientPayload }) => useOnboardingController(user), { wrapper, initialProps: { user: USER } }), client };
}

describe('onboarding controller', () => {
    beforeAll(() => notifyManager.setNotifyFunction(async (callback) => { await act(callback); }));
    afterAll(() => notifyManager.setNotifyFunction((callback) => { callback(); }));
    beforeEach(() => {
        jest.clearAllMocks();
        mockInitialForm = { ...FORM };
        mockInitialStep = 'plan';
        mockIsOnline = true;
        mockServerUrl = 'https://health.example';
        mockClearDraft.mockReset().mockResolvedValue(undefined);
        mockApi.getCaloriePlanOptions.mockReset().mockResolvedValue(OPTIONS);
        mockApi.completeOnboarding.mockReset().mockResolvedValue({ user: COMPLETED_USER, receipt: {} });
        jest.mocked(Crypto.randomUUID).mockReset()
            .mockReturnValueOnce('00000000-0000-0000-0000-000000000001')
            .mockReturnValueOnce('00000000-0000-0000-0000-000000000002');
    });

    it('reuses the operation ID for an unchanged retry and creates one after the submitted data changes', async () => {
        mockApi.completeOnboarding.mockRejectedValueOnce(new Error('Network unavailable'))
            .mockRejectedValueOnce(new Error('Network unavailable'));
        const { result } = await renderController();
        await waitFor(() => expect(result.current.planVerified).toBe(true));
        await act(() => result.current.next());
        await waitFor(() => expect(result.current.completion.isError).toBe(true));
        expect(mockClearDraft).not.toHaveBeenCalled();
        expect(result.current.form).toEqual(FORM);
        await act(() => result.current.next());
        await waitFor(() => expect(mockApi.completeOnboarding).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(result.current.completion.isPending).toBe(false));
        expect(mockApi.completeOnboarding.mock.calls[1][1]).toBe(mockApi.completeOnboarding.mock.calls[0][1]);
        await act(() => result.current.setForm((form) => ({ ...form, targetWeight: '69', targetWeightGrams: 69000 })));
        await act(() => result.current.next());
        await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/today'));
        expect(mockApi.completeOnboarding.mock.calls[2][1]).not.toBe(mockApi.completeOnboarding.mock.calls[0][1]);
        expect(Crypto.randomUUID).toHaveBeenCalledTimes(2);
    });

    it('submits only once for rapid presses before mutation state rerenders', async () => {
        let resolveCompletion!: (value: unknown) => void;
        mockApi.completeOnboarding.mockImplementationOnce(() => new Promise((resolve) => { resolveCompletion = resolve; }));
        const { result } = await renderController();
        await waitFor(() => expect(result.current.planVerified).toBe(true));
        await act(() => { result.current.next(); result.current.next(); });
        await waitFor(() => expect(mockApi.completeOnboarding).toHaveBeenCalledTimes(1));
        await act(async () => resolveCompletion({ user: COMPLETED_USER, receipt: {} }));
        await waitFor(() => expect(router.replace).toHaveBeenCalledTimes(1));
    });

    it('opens Today after durable completion even if background cache refresh fails', async () => {
        const { result, client } = await renderController();
        jest.spyOn(client, 'invalidateQueries').mockRejectedValue(new Error('Refresh failed'));
        await waitFor(() => expect(result.current.planVerified).toBe(true));
        await act(() => result.current.next());
        await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/today'));
        expect(mockClearDraft).toHaveBeenCalled();
        expect(mockUpdateCurrentUser).toHaveBeenCalledWith(COMPLETED_USER);
        expect(reportClientOperationFailure).not.toHaveBeenCalled();
        expect(result.current.actionError).toBeNull();
    });

    it.each([
        ['height_mm', 'height', 'about'],
        ['activity_level', 'activityLevel', 'activity'],
        ['target_weight_grams', 'targetWeight', 'plan'],
        ['daily_deficit', 'dailyChangeAbs', 'plan']
    ] as const)('shows %s server errors at the affected field', async (serverField, field, step) => {
        mockApi.completeOnboarding.mockRejectedValueOnce(new ApiError('Invalid details', 400, { field_errors: { [serverField]: ['Review this value.'] } }));
        const { result } = await renderController();
        await waitFor(() => expect(result.current.planVerified).toBe(true));
        await act(() => result.current.next());
        await waitFor(() => expect(result.current.errors[field]).toBe('Review this value.'));
        expect(result.current.step).toBe(step);
        expect(result.current.focusAttempt).toBeGreaterThan(0);
        expect(mockClearDraft).not.toHaveBeenCalled();
        expect(router.replace).not.toHaveBeenCalled();
    });

    it('requires a new explicit pace when updated profile options make the old choice unavailable', async () => {
        const { result } = await renderController();
        await waitFor(() => expect(result.current.planVerified).toBe(true));
        mockApi.getCaloriePlanOptions.mockResolvedValueOnce({
            ...OPTIONS,
            planOptions: OPTIONS.planOptions.map((option) => option.dailyDeficit === 500
                ? { ...option, available: false, dailyCalorieTarget: null, reasonCode: 'TARGET_BELOW_MINIMUM' } : option)
        });
        await act(() => result.current.setForm((form) => ({ ...form, activityLevel: 'SEDENTARY' })));
        await waitFor(() => expect(result.current.form.dailyChangeAbs).toBe(''));
        expect(result.current.errors.dailyChangeAbs).toContain('Choose an available pace');
        expect(result.current.planVerified).toBe(false);
        expect(mockApi.completeOnboarding).not.toHaveBeenCalled();
    });

    it('retains the selected pace during a failed profile check and blocks submission', async () => {
        const { result } = await renderController();
        await waitFor(() => expect(result.current.planVerified).toBe(true));
        mockApi.getCaloriePlanOptions.mockRejectedValueOnce(new Error('Network unavailable'));
        await act(() => result.current.setForm((form) => ({ ...form, activityLevel: 'LIGHT' })));
        await waitFor(() => expect(result.current.planQuery.isError).toBe(true));
        expect(result.current.form.dailyChangeAbs).toBe('500');
        expect(result.current.planVerified).toBe(false);
        await act(() => result.current.next());
        expect(mockApi.completeOnboarding).not.toHaveBeenCalled();
    });

    it.each(['about', 'activity'] as const)('returns a restored final step to invalid %s details before submitting', async (step) => {
        mockInitialForm = step === 'about' ? { ...FORM, heightMillimeters: null } : { ...FORM, activityLevel: null };
        const { result } = await renderController();
        await act(() => result.current.next());
        expect(result.current.step).toBe(step);
        expect(result.current.returnToPlan).toBe(true);
        expect(Object.keys(result.current.errors)).not.toHaveLength(0);
        expect(mockApi.completeOnboarding).not.toHaveBeenCalled();
    });

    it('validates edits and returns directly to the plan without forcing the activity screen again', async () => {
        const { result } = await renderController();
        await waitFor(() => expect(result.current.planVerified).toBe(true));
        await act(() => result.current.editStep('about'));
        await act(() => result.current.setForm((form) => ({ ...form, heightMillimeters: null })));
        await act(() => result.current.next());
        expect(result.current.step).toBe('about');
        expect(result.current.errors.height).toBeDefined();
        await act(() => result.current.setForm((form) => ({ ...form, heightMillimeters: 1700, heightCm: '170' })));
        await act(() => result.current.next());
        expect(result.current.step).toBe('plan');
        expect(result.current.returnToPlan).toBe(false);
        expect(result.current.form.currentWeightGrams).toBe(80000);
        await act(() => result.current.editStep('activity'));
        await act(() => result.current.back());
        expect(result.current.step).toBe('plan');
    });


    it.each(['unmount', 'account', 'server'] as const)('ignores a completion that arrives after %s replacement', async (change) => {
        let resolveCompletion!: (value: unknown) => void;
        mockApi.completeOnboarding.mockImplementationOnce(() => new Promise((resolve) => { resolveCompletion = resolve; }));
        const { result, unmount, rerender, client } = await renderController();
        const invalidate = jest.spyOn(client, 'invalidateQueries');
        await waitFor(() => expect(result.current.planVerified).toBe(true));
        await act(() => result.current.next());
        await waitFor(() => expect(mockApi.completeOnboarding).toHaveBeenCalledTimes(1));
        if (change === 'unmount') await unmount();
        else {
            if (change === 'server') mockServerUrl = 'https://another.example';
            await rerender({ user: { ...USER, id: change === 'account' ? 8 : USER.id } });
        }
        await act(async () => resolveCompletion({ user: COMPLETED_USER, receipt: {} }));
        if (change !== 'unmount') await waitFor(() => expect(result.current.completion.isSuccess).toBe(true));
        expect(mockUpdateCurrentUser).not.toHaveBeenCalled();
        expect(router.replace).not.toHaveBeenCalled();
        expect(mockClearDraft).not.toHaveBeenCalled();
        expect(invalidate).not.toHaveBeenCalled();
    });

    it('does not restore a session that ends while successful completion is clearing its draft', async () => {
        let finishCleanup!: () => void;
        mockClearDraft.mockImplementationOnce(() => new Promise<undefined>((resolve) => { finishCleanup = () => resolve(undefined); }));
        const { result, unmount } = await renderController();
        await waitFor(() => expect(result.current.planVerified).toBe(true));
        await act(() => result.current.next());
        await waitFor(() => expect(mockClearDraft).toHaveBeenCalledTimes(1));
        await unmount();
        await act(async () => finishCleanup());
        expect(mockUpdateCurrentUser).not.toHaveBeenCalled();
        expect(router.replace).not.toHaveBeenCalled();
    });

    it('ignores late server field errors after the account changes', async () => {
        let rejectCompletion!: (error: unknown) => void;
        mockApi.completeOnboarding.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectCompletion = reject; }));
        const { result, rerender } = await renderController();
        await waitFor(() => expect(result.current.planVerified).toBe(true));
        await act(() => result.current.next());
        await waitFor(() => expect(mockApi.completeOnboarding).toHaveBeenCalledTimes(1));
        await rerender({ user: { ...USER, id: 8 } });
        await act(async () => rejectCompletion(new ApiError('Invalid details', 400, { field_errors: { height_mm: ['Review height.'] } })));
        await waitFor(() => expect(result.current.completion.isError).toBe(true));
        expect(result.current.step).toBe('plan');
        expect(result.current.errors).toEqual({});
        expect(result.current.focusAttempt).toBe(0);
        expect(result.current.actionError).toBeNull();
        expect(reportClientOperationFailure).not.toHaveBeenCalled();
    });

    it('does not start tracking while offline', async () => {
        mockIsOnline = false;
        const { result } = await renderController();
        await waitFor(() => expect(result.current.planVerified).toBe(true));
        await act(() => result.current.next());
        expect(result.current.actionError).toContain('Connect to the internet');
        expect(mockApi.completeOnboarding).not.toHaveBeenCalled();
    });
});
