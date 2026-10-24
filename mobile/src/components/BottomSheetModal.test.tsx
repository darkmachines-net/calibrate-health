/** @file Regression coverage for Bottom Sheet Modal: BottomSheetModal. */

import { Modal, StyleSheet, Text } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import {
    BottomSheetModal,
    createWebBottomSheetContainerObserver,
    resolveAdaptiveDialogWidth,
    resolveFixedSheetHeight,
    resolveSheetEntranceOffset
} from './BottomSheetModal';

jest.mock('@expo/vector-icons/Ionicons', () => () => null);

jest.mock('../hooks/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => true
}));

jest.mock('../hooks/useVisualViewportHeight', () => ({
    useVisualViewportHeight: () => 720
}));

jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 })
}));

describe('BottomSheetModal', () => {
    it('resolves percentage heights against the web visual viewport', () => {
        expect(resolveFixedSheetHeight('92%', 844)).toBeCloseTo(776.48);
    });

    it('preserves native percentages and explicit dimensions', () => {
        expect(resolveFixedSheetHeight('92%', undefined)).toBe('92%');
        expect(resolveFixedSheetHeight(640, 844)).toBe(640);
    });

    it('switches from edge-to-edge sheets to bounded standard and wide dialogs at tablet widths', () => {
        expect(resolveAdaptiveDialogWidth(719, 'standard', 24)).toBeUndefined();
        expect(resolveAdaptiveDialogWidth(720, 'standard', 24)).toBe(640);
        expect(resolveAdaptiveDialogWidth(720, 'wide', 24)).toBe(672);
        expect(resolveAdaptiveDialogWidth(1440, 'wide', 24)).toBe(800);
    });

    it('starts bottom sheets below the viewport while keeping dialog travel subtle', () => {
        expect(resolveSheetEntranceOffset(844, false)).toBe(844);
        expect(resolveSheetEntranceOffset(844, true)).toBe(32);
    });

    it('keeps the panel hidden until the native modal reports that it is mounted', () => {
        const screen = render(
            <BottomSheetModal visible onRequestClose={jest.fn()}>
                <Text>Choose a date</Text>
            </BottomSheetModal>
        );

        expect(StyleSheet.flatten(screen.getByTestId('adaptive-dialog-panel').props.style).opacity).toBe(0);
        expect(screen.UNSAFE_getByType(Modal).props.supportedOrientations).toEqual([
            'portrait',
            'portrait-upside-down',
            'landscape',
            'landscape-left',
            'landscape-right'
        ]);

        act(() => {
            screen.UNSAFE_getByType(Modal).props.onShow();
        });

        expect(StyleSheet.flatten(screen.getByTestId('adaptive-dialog-panel').props.style).opacity).toBe(1);
    });

    it('anchors the web viewport root while the underlying page is scrolled', () => {
        const screen = render(
            <BottomSheetModal visible onRequestClose={jest.fn()}>
                <Text>Review calorie target</Text>
            </BottomSheetModal>
        );

        expect(StyleSheet.flatten(screen.getByTestId('bottom-sheet-root').props.style)).toMatchObject({
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            height: 720
        });
    });

    it('keeps the backdrop out of keyboard navigation and provides an explicit close action', () => {
        const onRequestClose = jest.fn();
        const screen = render(
            <BottomSheetModal
                visible
                accessibilityLabel="Calibration details"
                showCloseButton
                showHandle={false}
                onRequestClose={onRequestClose}
            >
                <Text>Review calorie target</Text>
            </BottomSheetModal>
        );

        expect(screen.getByTestId('bottom-sheet-backdrop', { includeHiddenElements: true }).props).toMatchObject({
            accessible: false,
            importantForAccessibility: 'no-hide-descendants',
            'aria-hidden': true
        });
        expect(screen.getByTestId('bottom-sheet-fixed-controls')).toBeTruthy();
        expect(screen.getByTestId('bottom-sheet-scroll')).toBeTruthy();
        fireEvent.press(screen.getByLabelText('Close calibration details'));
        expect(onRequestClose).toHaveBeenCalledTimes(1);
    });

    it('associates an accessible title and description with the dialog surface', () => {
        const screen = render(
            <BottomSheetModal
                visible
                title="Edit calorie goal"
                description="Choose a safe daily target."
                onRequestClose={jest.fn()}
            >
                <Text>Goal fields</Text>
            </BottomSheetModal>
        );

        const panel = screen.getByTestId('adaptive-dialog-panel');
        expect(panel.props).toMatchObject({
            role: 'dialog',
            'aria-modal': true,
            'aria-labelledby': screen.getByText('Edit calorie goal').props.nativeID,
            'aria-describedby': screen.getByText('Choose a safe daily target.').props.nativeID
        });
    });

    it('allows fixed-content sheets to own their bottom inset', () => {
        const screen = render(
            <BottomSheetModal
                visible
                scrollable={false}
                contentStyle={{ paddingBottom: 0 }}
                onRequestClose={jest.fn()}
            >
                <Text>Edge-aligned results</Text>
            </BottomSheetModal>
        );

        expect(StyleSheet.flatten(screen.getByTestId('bottom-sheet-content').props.style).paddingBottom).toBe(0);
    });

    it('normalizes stacked web modal containers and lets a successor observer take over after cleanup', () => {
        function createContainer(role: string | null) {
            const attributes = new Map<string, string>([['aria-modal', 'true']]);
            if (role) attributes.set('role', role);
            const removeAttribute = jest.fn((name: string) => attributes.delete(name));
            return {
                attributes,
                removeAttribute,
                element: {
                    getAttribute: (name: string) => attributes.get(name) ?? null,
                    querySelector: (selector: string) => (
                        selector === '[data-testid="adaptive-dialog-panel"]' ? {} : null
                    ),
                    removeAttribute
                } as unknown as HTMLElement
            };
        }

        const inactive = createContainer(null);
        const active = createContainer('dialog');
        let containers = [inactive.element, active.element];
        const documentRoot = {
            body: {} as Node,
            querySelectorAll: jest.fn(() => containers)
        };
        const observers: Array<{
            callback: MutationCallback;
            disconnect: jest.Mock;
            observe: jest.Mock;
        }> = [];
        const observerFactory = jest.fn((callback: MutationCallback) => {
            const observer = {
                callback,
                disconnect: jest.fn(),
                observe: jest.fn()
            };
            observers.push(observer);
            return observer;
        });

        const firstObserver = createWebBottomSheetContainerObserver(documentRoot, observerFactory);
        expect(inactive.attributes.has('aria-modal')).toBe(false);
        expect(active.attributes.get('aria-modal')).toBe('true');
        expect(active.attributes.get('role')).toBe('dialog');
        expect(active.removeAttribute).not.toHaveBeenCalled();
        expect(observers[0].observe).toHaveBeenCalledWith(documentRoot.body, expect.objectContaining({
            attributeFilter: ['aria-modal', 'role'],
            subtree: true
        }));

        firstObserver.disconnect();
        expect(observers[0].disconnect).toHaveBeenCalledTimes(1);

        const successor = createContainer(null);
        containers = [successor.element];
        const successorObserver = createWebBottomSheetContainerObserver(documentRoot, observerFactory);
        expect(successor.attributes.has('aria-modal')).toBe(false);
        expect(observers).toHaveLength(2);
        expect(successorObserver).not.toBe(firstObserver);
    });
    it('guards every platform close request while saving', async () => {
        const onRequestClose = jest.fn();
        const screen = render(
            <BottomSheetModal visible dismissDisabled showCloseButton onRequestClose={onRequestClose}>
                <Text>Saving goal</Text>
            </BottomSheetModal>
        );

        fireEvent.press(screen.getByLabelText('Close details'));
        fireEvent.press(screen.getByTestId('bottom-sheet-backdrop', { includeHiddenElements: true }));
        await act(async () => {
            screen.UNSAFE_getByType(Modal).props.onRequestClose();
        });
        expect(onRequestClose).not.toHaveBeenCalled();
    });

    it('confirms dirty dismissal before closing', async () => {
        const onRequestClose = jest.fn();
        const confirmDismiss = jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        const screen = render(
            <BottomSheetModal
                visible
                isDirty
                confirmDismiss={confirmDismiss}
                onRequestClose={onRequestClose}
            >
                <Text>Changed goal</Text>
            </BottomSheetModal>
        );
        const modal = screen.UNSAFE_getByType(Modal);

        await act(async () => {
            modal.props.onRequestClose();
        });
        expect(confirmDismiss).toHaveBeenCalledTimes(1);
        expect(onRequestClose).not.toHaveBeenCalled();

        await act(async () => {
            modal.props.onRequestClose();
        });
        expect(confirmDismiss).toHaveBeenCalledTimes(2);
        expect(onRequestClose).toHaveBeenCalledTimes(1);
    });
});
