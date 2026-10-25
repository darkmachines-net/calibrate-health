/** @file Accessible form-error summary with focus control for failed submissions. */

import { forwardRef, useImperativeHandle, useRef } from 'react';
import { AccessibilityInfo, findNodeHandle, View, type TextStyle } from 'react-native';
import { AppText } from './AppText';

export type FormErrorSummaryHandle = {
    focus: () => void;
};

type FormErrorSummaryProps = {
    message: string;
    style?: TextStyle;
};

type FocusableView = React.ComponentRef<typeof View> & { focus?: () => void };

export const FormErrorSummary = forwardRef<FormErrorSummaryHandle, FormErrorSummaryProps>(
    function FormErrorSummary({ message, style }, ref) {
        const summaryRef = useRef<React.ComponentRef<typeof View>>(null);

        useImperativeHandle(ref, () => ({
            focus() {
                (summaryRef.current as FocusableView | null)?.focus?.();
                const handle = findNodeHandle(summaryRef.current);
                if (handle != null) AccessibilityInfo.setAccessibilityFocus(handle);
                AccessibilityInfo.announceForAccessibility(message);
            }
        }), [message]);

        return (
            <View
                ref={summaryRef}
                accessible
                accessibilityRole="alert"
                tabIndex={-1}
            >
                <AppText style={style}>{message}</AppText>
            </View>
        );
    }
);
