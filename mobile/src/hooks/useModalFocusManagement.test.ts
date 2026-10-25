/** @file Regression coverage for use Modal Focus Management: useModalFocusManagement. */

import { act, renderHook } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { useModalFocusManagement } from './useModalFocusManagement';

type FakeEvent = {
    key?: string;
    shiftKey?: boolean;
    target?: FakeElement;
    preventDefault: jest.Mock;
};

type FakeListener = (event: FakeEvent) => void;

class FakeDocument {
    activeElement: FakeElement | null = null;
    private readonly listeners = new Map<string, Set<FakeListener>>();

    addEventListener(type: string, listener: FakeListener) {
        const listeners = this.listeners.get(type) ?? new Set<FakeListener>();
        listeners.add(listener);
        this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: FakeListener) {
        this.listeners.get(type)?.delete(listener);
    }

    dispatch(type: string, event: FakeEvent) {
        [...(this.listeners.get(type) ?? [])].forEach((listener) => listener(event));
    }
}

class FakeElement {
    readonly children: FakeElement[] = [];
    isConnected = true;

    constructor(
        readonly ownerDocument: FakeDocument,
        readonly parent: FakeElement | null = null
    ) {
        parent?.children.push(this);
    }

    contains(target: unknown): boolean {
        if (target === this) return true;
        return this.children.some((child) => child.contains(target));
    }

    focus() {
        this.ownerDocument.activeElement = this;
        this.ownerDocument.dispatch('focusin', {
            target: this,
            preventDefault: jest.fn()
        });
    }

    getAttribute() {
        return null;
    }

    querySelectorAll() {
        const descendants: FakeElement[] = [];
        function visit(element: FakeElement) {
            descendants.push(...element.children);
            element.children.forEach(visit);
        }
        visit(this);
        return descendants;
    }
}

describe('useModalFocusManagement', () => {
    const originalDocument = globalThis.document;
    const originalHTMLElement = globalThis.HTMLElement;
    const originalNode = globalThis.Node;
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const originalPlatformOS = Platform.OS;

    beforeEach(() => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    });

    afterEach(() => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOS });
        Object.assign(globalThis, {
            document: originalDocument,
            HTMLElement: originalHTMLElement,
            Node: originalNode,
            requestAnimationFrame: originalRequestAnimationFrame,
            cancelAnimationFrame: originalCancelAnimationFrame
        });
    });

    it('lets only the topmost nested modal contain focus and handle Escape', async () => {
        const fakeDocument = new FakeDocument();
        Object.assign(globalThis, {
            document: fakeDocument,
            HTMLElement: FakeElement,
            Node: FakeElement,
            requestAnimationFrame: (callback: FrameRequestCallback) => {
                callback(0);
                return 1;
            },
            cancelAnimationFrame: jest.fn()
        });

        const pageTrigger = new FakeElement(fakeDocument);
        const outerPanel = new FakeElement(fakeDocument);
        const outerSelectorTrigger = new FakeElement(fakeDocument, outerPanel);
        const innerPanel = new FakeElement(fakeDocument);
        const innerOption = new FakeElement(fakeDocument, innerPanel);
        const outerClose = jest.fn();
        const innerClose = jest.fn();
        pageTrigger.focus();

        const hook = await renderHook(
            ({ innerVisible }: { innerVisible: boolean }) => {
                useModalFocusManagement({
                    visible: true,
                    containerRef: { current: outerPanel },
                    initialFocusRef: { current: outerSelectorTrigger },
                    onEscape: outerClose
                });
                useModalFocusManagement({
                    visible: innerVisible,
                    containerRef: { current: innerPanel },
                    initialFocusRef: { current: innerOption },
                    onEscape: innerClose
                });
            },
            { initialProps: { innerVisible: false } }
        );

        expect(fakeDocument.activeElement).toBe(outerSelectorTrigger);
        outerSelectorTrigger.focus();

        await hook.rerender({ innerVisible: true });
        expect(fakeDocument.activeElement).toBe(innerOption);

        await act(() => {
            fakeDocument.dispatch('keydown', {
                key: 'Escape',
                preventDefault: jest.fn()
            });
        });
        expect(innerClose).toHaveBeenCalledTimes(1);
        expect(outerClose).not.toHaveBeenCalled();

        await hook.rerender({ innerVisible: false });
        expect(fakeDocument.activeElement).toBe(outerSelectorTrigger);

        await act(() => {
            fakeDocument.dispatch('keydown', {
                key: 'Escape',
                preventDefault: jest.fn()
            });
        });
        expect(outerClose).toHaveBeenCalledTimes(1);

        await hook.unmount();
    });
});
