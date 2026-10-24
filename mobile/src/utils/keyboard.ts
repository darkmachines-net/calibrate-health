/** @file keyboard: Keeps form content visible above the native keyboard on each supported platform. */

export type KeyboardAvoidingBehavior = 'height' | 'padding' | undefined;

/** Keeps form content visible above the native keyboard on each supported platform. */
export function getKeyboardAvoidingBehavior(platform: string): KeyboardAvoidingBehavior {
    if (platform === 'ios') return 'padding';
    if (platform === 'android') return 'height';
    return undefined;
}
