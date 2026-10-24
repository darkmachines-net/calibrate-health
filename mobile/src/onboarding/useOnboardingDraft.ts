/** @file use Onboarding Draft: Hydrate once per account, keeping transient form state separate from completed server data. */

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { UserClientPayload } from '@calibrate/api-client';
import { createInitialOnboardingForm, type OnboardingFormState } from './completionState';
import {
    bindOnboardingDraft,
    clearOnboardingDraft,
    isOnboardingDraftBindingCurrent,
    onboardingDraftStorageKey,
    readOnboardingDraft,
    writeOnboardingDraft,
    type OnboardingDraftBinding,
    type OnboardingDraftStep
} from './draftStorage';

const STORAGE_ERROR = 'Progress could not be saved on this device. You can still finish setup.';

type DraftState = {
    key: string;
    form: OnboardingFormState;
    step: OnboardingDraftStep;
    isHydrating: boolean;
    revision: number;
    storageError: string | null;
};

/** Hydrate once per account, keeping transient form state separate from completed server data. */
export function useOnboardingDraft({ serverUrl, user }: { serverUrl: string; user: UserClientPayload }) {
    const key = onboardingDraftStorageKey(serverUrl, user.id);
    const latestUser = useRef(user);
    latestUser.current = user;
    const [state, setState] = useState<DraftState>(() => ({
        key,
        form: createInitialOnboardingForm(user),
        step: 'about',
        isHydrating: true,
        revision: 0,
        storageError: null
    }));
    const bindingRef = useRef<OnboardingDraftBinding | null>(null);
    const activeKeyRef = useRef(key);
    activeKeyRef.current = key;
    const isCompleted = Boolean(user.onboarding_completed_at);

    useEffect(() => {
        let active = true;
        const binding = bindOnboardingDraft(serverUrl, user.id);
        bindingRef.current = binding;
        const initialForm = createInitialOnboardingForm(latestUser.current);
        setState({ key, form: initialForm, step: 'about', isHydrating: true, revision: 0, storageError: null });
        const isCurrent = () => active && activeKeyRef.current === key && isOnboardingDraftBindingCurrent(binding);
        if (isCompleted) {
            bindingRef.current = null;
            void clearOnboardingDraft(serverUrl, user.id).catch(() => undefined);
            setState({ key, form: initialForm, step: 'about', isHydrating: false, revision: 0, storageError: null });
            return () => { active = false; };
        }
        void readOnboardingDraft(binding).then((draft) => {
            if (!isCurrent()) return;
            setState({
                key,
                form: draft?.form ?? initialForm,
                step: draft?.step ?? 'about',
                isHydrating: false,
                revision: 0,
                storageError: null
            });
        }).catch(() => {
            if (isCurrent()) setState({ key, form: initialForm, step: 'about', isHydrating: false, revision: 0, storageError: STORAGE_ERROR });
        });
        return () => { active = false; };
    }, [isCompleted, key, serverUrl, user.id]);

    useEffect(() => {
        const binding = bindingRef.current;
        if (state.key !== key || state.isHydrating || state.revision === 0 || isCompleted || !binding || !isOnboardingDraftBindingCurrent(binding)) return;
        void writeOnboardingDraft(binding, { version: 1, form: state.form, step: state.step }).catch(() => {
            if (activeKeyRef.current === key && isOnboardingDraftBindingCurrent(binding)) {
                setState((current) => current.key === key ? { ...current, storageError: STORAGE_ERROR } : current);
            }
        });
    }, [isCompleted, key, state.form, state.isHydrating, state.key, state.revision, state.step]);

    const setForm = useCallback<Dispatch<SetStateAction<OnboardingFormState>>>((update) => {
        setState((current) => {
            if (current.key !== key || current.isHydrating) return current;
            return { ...current, form: typeof update === 'function' ? update(current.form) : update, revision: current.revision + 1 };
        });
    }, [key]);
    const setStep = useCallback<Dispatch<SetStateAction<OnboardingDraftStep>>>((update) => {
        setState((current) => {
            if (current.key !== key || current.isHydrating) return current;
            return { ...current, step: typeof update === 'function' ? update(current.step) : update, revision: current.revision + 1 };
        });
    }, [key]);
    const clearDraft = useCallback(async () => {
        bindingRef.current = null;
        try {
            await clearOnboardingDraft(serverUrl, user.id);
        } catch {
            if (activeKeyRef.current === key) setState((current) => ({ ...current, storageError: STORAGE_ERROR }));
        }
    }, [key, serverUrl, user.id]);

    return {
        form: state.key === key ? state.form : createInitialOnboardingForm(user),
        setForm,
        step: state.key === key ? state.step : 'about' as OnboardingDraftStep,
        setStep,
        isHydrating: state.key !== key || state.isHydrating,
        storageError: state.key === key ? state.storageError : null,
        clearDraft
    };
}
