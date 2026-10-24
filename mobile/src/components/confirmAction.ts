/** @file confirm Action: Resolves a destructive confirmation consistently on web and native. */

import { Alert, Platform } from 'react-native';

type ConfirmActionOptions = {
    title: string;
    message: string;
    cancelLabel: string;
    confirmLabel: string;
    destructive?: boolean;
};

/** Resolves a destructive confirmation consistently on web and native. */
export function confirmAction({
    title,
    message,
    cancelLabel,
    confirmLabel,
    destructive = false
}: ConfirmActionOptions): Promise<boolean> {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
        return Promise.resolve(window.confirm(`${title}\n\n${message}`));
    }

    return new Promise((resolve) => {
        Alert.alert(title, message, [
            { text: cancelLabel, style: 'cancel', onPress: () => resolve(false) },
            {
                text: confirmLabel,
                style: destructive ? 'destructive' : 'default',
                onPress: () => resolve(true)
            }
        ], { cancelable: true, onDismiss: () => resolve(false) });
    });
}
