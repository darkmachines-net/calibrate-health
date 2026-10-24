/** @file Account/server-isolated onboarding draft persistence, recovery, and cleanup. */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { isOnboardingFormState, type OnboardingFormState } from './completionState';

export type OnboardingDraftStep = 'about' | 'activity' | 'plan';
export type OnboardingDraft = { version: 1; form: OnboardingFormState; step: OnboardingDraftStep };
export type OnboardingDraftBinding = { key: string; generation: number };

type StorageQueue = { generation: number; tail: Promise<void> };
const queues = new Map<string, StorageQueue>();
const STORAGE_PREFIX = '@calibrate/onboarding-draft/v1';

/** Builds an onboarding draft key isolated by normalized server origin and account. */
export function onboardingDraftStorageKey(serverUrl: string, userId: number): string {
    return `${STORAGE_PREFIX}/${encodeURIComponent(new URL(serverUrl).origin.toLowerCase())}/${userId}`;
}

function queueFor(key: string): StorageQueue {
    let queue = queues.get(key);
    if (!queue) {
        queue = { generation: 0, tail: Promise.resolve() };
        queues.set(key, queue);
    }
    return queue;
}

function enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const queue = queueFor(key);
    const result = queue.tail.then(operation);
    queue.tail = result.then(() => undefined, () => undefined);
    return result;
}

/** Captures the current draft generation so stale asynchronous work cannot write into a reset draft. */
export function bindOnboardingDraft(serverUrl: string, userId: number): OnboardingDraftBinding {
    const key = onboardingDraftStorageKey(serverUrl, userId);
    return { key, generation: queueFor(key).generation };
}

/** Reports whether a draft binding still owns the current storage generation. */
export function isOnboardingDraftBindingCurrent(binding: OnboardingDraftBinding): boolean {
    return queueFor(binding.key).generation === binding.generation;
}

function parseDraft(encoded: string): OnboardingDraft | null {
    try {
        const value: unknown = JSON.parse(encoded);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const draft = value as Partial<OnboardingDraft>;
        if (draft.version !== 1 || !isOnboardingFormState(draft.form)) return null;
        if (draft.step !== 'about' && draft.step !== 'activity' && draft.step !== 'plan') return null;
        return { version: 1, form: draft.form, step: draft.step };
    } catch {
        return null;
    }
}

/** Serializes draft reads, rejects stale bindings, and removes malformed stored drafts. */
export function readOnboardingDraft(binding: OnboardingDraftBinding): Promise<OnboardingDraft | null> {
    return enqueue(binding.key, async () => {
        if (!isOnboardingDraftBindingCurrent(binding)) return null;
        const encoded = await AsyncStorage.getItem(binding.key);
        if (!isOnboardingDraftBindingCurrent(binding) || encoded === null) return null;
        const draft = parseDraft(encoded);
        if (!draft) await AsyncStorage.removeItem(binding.key);
        return draft;
    });
}

/** Serializes draft writes and ignores work whose account binding generation has been invalidated. */
export function writeOnboardingDraft(binding: OnboardingDraftBinding, draft: OnboardingDraft): Promise<void> {
    const encoded = JSON.stringify(draft);
    return enqueue(binding.key, async () => {
        if (isOnboardingDraftBindingCurrent(binding)) await AsyncStorage.setItem(binding.key, encoded);
    });
}

/** Invalidate pending saves before removing any write that has already reached storage. */
export function clearOnboardingDraft(serverUrl: string, userId: number): Promise<void> {
    const key = onboardingDraftStorageKey(serverUrl, userId);
    queueFor(key).generation += 1;
    return enqueue(key, () => AsyncStorage.removeItem(key));
}
