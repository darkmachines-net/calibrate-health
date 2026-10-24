/** @file haptics: Honor the account preference without letting optional device feedback block logging flows. */

import * as Haptics from 'expo-haptics';

export type HapticFeedbackKind = 'selection' | 'success' | 'warning' | 'error';

/** Honor the account preference without letting optional device feedback block logging flows. */
export function triggerHapticFeedback(enabled: boolean | undefined, kind: HapticFeedbackKind): void {
    if (enabled === false) return;

    try {
        let feedback: Promise<void>;
        switch (kind) {
            case 'selection':
                feedback = Haptics.selectionAsync();
                break;
            case 'warning':
                feedback = Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
                break;
            case 'error':
                feedback = Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
                break;
            default:
                feedback = Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
        void feedback.catch(() => undefined);
    } catch {
        // Browsers and devices can expose incomplete haptics engines; feedback remains optional.
    }
}
