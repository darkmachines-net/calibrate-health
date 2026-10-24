import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, Platform } from 'react-native';
import * as Crypto from 'expo-crypto';
import { router } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, type UserClientPayload } from '@calibrate/api-client';
import { useAuth } from '../auth/AuthContext';
import { useOnlineStatus } from '../components/AsyncStateBoundary';
import { getSafeActionErrorMessage } from '../errors/presentation';
import { getCaloriePlanPresentation } from '../caloriePlanning/presentation';
import { reportClientOperationFailure } from '../diagnostics/operationDiagnostics';
import { getSignedDailyDeficit, DAILY_GOAL_CHANGE_OPTIONS } from '../utils/goals';
import { useOnboardingDraft } from './useOnboardingDraft';
import { buildCaloriePlanDraft, buildOnboardingCompleteData, validateOnboardingStep, type OnboardingErrors, type OnboardingField } from './completionState';
import { ONBOARDING_STEPS } from './steps';

type SubmissionScope = { account: string; generation: number };

const SERVER_FIELDS: Record<string, OnboardingField> = {
    current_weight_grams: 'currentWeight', height_mm: 'height', date_of_birth: 'dateOfBirth',
    sex: 'sex', timezone: 'timezone', activity_level: 'activityLevel',
    target_weight_grams: 'targetWeight', daily_deficit: 'dailyChangeAbs'
};

export function useOnboardingController(user: UserClientPayload) {
    const { api, serverUrl, updateCurrentUser } = useAuth();
    const draft = useOnboardingDraft({ user, serverUrl });
    const { form, setForm, step, setStep } = draft;
    const queryClient = useQueryClient();
    const isOnline = useOnlineStatus();
    const [errors, setErrors] = useState<OnboardingErrors>({});
    const [actionError, setActionError] = useState<string | null>(null);
    const [returnToPlan, setReturnToPlan] = useState(false);
    const [focusAttempt, setFocusAttempt] = useState(0);
    const submission = useRef<{ payload: string; operationId: string } | null>(null);
    const submitting = useRef(false);
    const account = `${serverUrl}/${user.id}`;
    const currentAccount = useRef(account);
    currentAccount.current = account;
    const mounted = useRef(false);
    const generation = useRef(0);
    const submissionScope = useRef<SubmissionScope | null>(null);

    useEffect(() => {
        mounted.current = true;
        generation.current += 1;
        return () => {
            mounted.current = false;
            generation.current += 1;
        };
    }, [account]);

    function isCurrentSubmission(scope: SubmissionScope | null): boolean {
        return mounted.current && scope !== null
            && scope.account === currentAccount.current && scope.generation === generation.current;
    }
    const caloriePlanDraft = useMemo(() => buildCaloriePlanDraft(form), [form]);
    const planQuery = useQuery({
        queryKey: ['calorie-plan-options', caloriePlanDraft],
        queryFn: () => api.getCaloriePlanOptions(caloriePlanDraft!),
        enabled: !draft.isHydrating && caloriePlanDraft !== null
    });
    const hasPace = form.goalMode === 'maintain'
        || DAILY_GOAL_CHANGE_OPTIONS.some((value) => String(value) === form.dailyChangeAbs);
    const dailyDeficit = form.goalMode && hasPace ? getSignedDailyDeficit(form.goalMode, form.dailyChangeAbs) : null;
    const selectedOption = dailyDeficit === null ? undefined : planQuery.data?.planOptions.find((option) => option.dailyDeficit === dailyDeficit);
    const planVerified = caloriePlanDraft !== null && !planQuery.isFetching && !planQuery.isError
        && planQuery.data?.eligibility.status === 'eligible' && selectedOption?.available === true;

    useEffect(() => {
        if (draft.isHydrating || !caloriePlanDraft || !planQuery.data || planQuery.isFetching || planQuery.isError
            || planQuery.data.eligibility.status !== 'eligible' || !form.goalMode || form.goalMode === 'maintain' || !form.dailyChangeAbs) return;
        if (selectedOption?.available !== true) {
            setForm((current) => ({ ...current, dailyChangeAbs: '' }));
            setErrors((current) => ({ ...current, dailyChangeAbs: 'Your details changed the available paces. Choose an available pace.' }));
        }
    }, [caloriePlanDraft, draft.isHydrating, form.dailyChangeAbs, form.goalMode, planQuery.data, planQuery.isError, planQuery.isFetching, selectedOption?.available, setForm]);

    const completion = useMutation({
        mutationFn: async () => {
            const data = buildOnboardingCompleteData(form);
            const payload = JSON.stringify(data);
            if (submission.current?.payload !== payload) submission.current = { payload, operationId: Crypto.randomUUID() };
            return api.completeOnboarding({ data }, submission.current.operationId);
        },
        onSuccess: async (result) => {
            const scope = submissionScope.current;
            if (!isCurrentSubmission(scope)) return;
            await draft.clearDraft();
            // A sign-out or account/server replacement can happen while storage is clearing.
            if (!isCurrentSubmission(scope)) return;
            // Completion is durable; background query refreshes must not turn it into a failed submission.
            void Promise.allSettled([
                queryClient.invalidateQueries({ queryKey: ['mobile-profile'] }),
                queryClient.invalidateQueries({ queryKey: ['mobile-goal'] }),
                queryClient.invalidateQueries({ queryKey: ['mobile-metrics'] }),
                queryClient.invalidateQueries({ queryKey: ['mobile-metrics-trend'] })
            ]);
            updateCurrentUser(result.user);
            router.replace('/today');
        },
        onError: (error) => {
            if (!isCurrentSubmission(submissionScope.current)) return;
            reportClientOperationFailure('onboarding_complete', error);
            const fieldErrors: OnboardingErrors = {};
            if (error instanceof ApiError) {
                for (const [key, messages] of Object.entries(error.fieldErrors ?? {})) {
                    if (SERVER_FIELDS[key] && messages[0]) fieldErrors[SERVER_FIELDS[key]] = messages[0];
                }
            }
            if (Object.keys(fieldErrors).length) {
                showErrors(fieldErrors);
                if (fieldErrors.currentWeight || fieldErrors.height || fieldErrors.dateOfBirth || fieldErrors.sex || fieldErrors.timezone) openStepForCorrection('about');
                else if (fieldErrors.activityLevel) openStepForCorrection('activity');
            } else {
                setActionError(getSafeActionErrorMessage(error, 'Unable to complete setup. Check your connection and try again.'));
            }
        },
        onSettled: () => { submitting.current = false; }
    });

    function showErrors(nextErrors: OnboardingErrors) {
        setErrors(nextErrors);
        setFocusAttempt((value) => value + 1);
    }

    function editStep(nextStep: 'about' | 'activity') {
        if (submitting.current || completion.isPending) return;
        openStepForCorrection(nextStep);
    }

    function openStepForCorrection(nextStep: 'about' | 'activity') {
        setReturnToPlan(true);
        setStep(nextStep);
        setActionError(null);
    }

    function next() {
        if (submitting.current || completion.isPending) return;
        setActionError(null);
        const nextErrors = validateOnboardingStep(form, step);
        if (Object.keys(nextErrors).length) { showErrors(nextErrors); return; }
        if (step === 'plan') {
            for (const previous of ['about', 'activity'] as const) {
                const previousErrors = validateOnboardingStep(form, previous);
                if (Object.keys(previousErrors).length) {
                    editStep(previous);
                    showErrors(previousErrors);
                    return;
                }
            }
            if (!isOnline || !planVerified) {
                setActionError(!isOnline ? 'Connect to the internet to check your plan and start tracking.'
                    : getCaloriePlanPresentation(planQuery.data?.eligibility.reasonCode).message);
                return;
            }
            submitting.current = true;
            submissionScope.current = { account, generation: generation.current };
            completion.mutate();
            return;
        }
        setErrors({});
        if (returnToPlan) {
            setReturnToPlan(false);
            setStep('plan');
        } else {
            setStep(step === 'about' ? 'activity' : 'plan');
        }
    }

    const back = useCallback(() => {
        if (completion.isPending) return;
        setErrors({});
        setActionError(null);
        if (returnToPlan) { setReturnToPlan(false); setStep('plan'); return; }
        if (step === 'plan') setStep('activity');
        if (step === 'activity') setStep('about');
    }, [completion.isPending, returnToPlan, setStep, step]);

    useEffect(() => {
        if (Platform.OS === 'web') return;
        const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
            if (completion.isPending) return true;
            if (step === 'about' && !returnToPlan) return false;
            back();
            return true;
        });
        return () => subscription.remove();
    }, [back, step, returnToPlan, completion.isPending]);

    const activeIndex = ONBOARDING_STEPS.findIndex((candidate) => candidate.key === step);
    return {
        ...draft, errors, showErrors, focusAttempt, actionError, activeIndex, returnToPlan,
        planQuery, selectedOption, planVerified, isOnline, completion, next, back, editStep,
        clearFieldError: (field: OnboardingField) => setErrors((current) => ({ ...current, [field]: undefined }))
    };
}
export type OnboardingController = ReturnType<typeof useOnboardingController>;
