/** @file Regression coverage for Calendar Modal web: CalendarModal web. */

import React from 'react';
import { CalendarModal } from './CalendarModal.web';

const mockUseModalFocusManagement = jest.fn();

jest.mock('react-dom', () => ({
    createPortal: (children: React.ReactNode) => children
}));
jest.mock('react-native', () => ({
    useWindowDimensions: () => ({ width: 1_024, height: 768 })
}));
jest.mock('../hooks/useModalFocusManagement', () => ({
    useModalFocusManagement: (options: unknown) => mockUseModalFocusManagement(options)
}));
jest.mock('./BottomSheetModal', () => ({
    ADAPTIVE_DIALOG_BREAKPOINT: 840,
    STANDARD_DIALOG_WIDTH: 640
}));
jest.mock('../theme', () => ({
    useAppTheme: () => ({
        colors: {
            outline: '#718071',
            outlineVariant: '#cdd7c9',
            scrim: 'rgba(0, 0, 0, 0.4)',
            surfaceContainerLow: '#ffffff'
        },
        radius: { pill: 999, sheet: 24 },
        spacing: { md: 16, lg: 24 },
        stroke: { control: 1 }
    })
}));

type TestInstance = {
    props: Record<string, unknown>;
    findAllByProps: (props: Record<string, unknown>) => TestInstance[];
};

const testRenderer = require('react-test-renderer') as {
    act: (callback: () => void) => void;
    create: (
        element: React.ReactElement,
        options?: { createNodeMock: () => unknown }
    ) => { root: TestInstance; unmount: () => void };
};

describe('CalendarModal web', () => {
    const originalDocument = globalThis.document;

    beforeEach(() => {
        mockUseModalFocusManagement.mockClear();
        Object.defineProperty(globalThis, 'document', {
            configurable: true,
            value: { body: {} }
        });
    });

    afterEach(() => {
        Object.defineProperty(globalThis, 'document', {
            configurable: true,
            value: originalDocument
        });
    });

    it('uses the shared modal stack and exposes one dialog owner', () => {
        const onRequestClose = jest.fn();
        let tree: { root: TestInstance; unmount: () => void };

        testRenderer.act(() => {
            tree = testRenderer.create(
                <CalendarModal visible onRequestClose={onRequestClose}>
                    <div>Date choices</div>
                </CalendarModal>,
                { createNodeMock: () => ({}) }
            );
        });

        expect(mockUseModalFocusManagement).toHaveBeenCalledTimes(1);
        const focusOptions = mockUseModalFocusManagement.mock.calls[0][0] as {
            visible: boolean;
            onEscape: () => void;
        };
        expect(focusOptions.visible).toBe(true);
        focusOptions.onEscape();
        expect(onRequestClose).toHaveBeenCalledTimes(1);
        expect(tree!.root.findAllByProps({ role: 'dialog' })).toHaveLength(1);

        testRenderer.act(() => tree!.unmount());
    });
});
