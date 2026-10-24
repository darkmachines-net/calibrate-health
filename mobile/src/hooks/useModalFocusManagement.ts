import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { Platform } from 'react-native';

export type ModalFocusableTarget = {
    focus?: () => void;
};

type ModalFocusManagementOptions = {
    visible: boolean;
    containerRef: RefObject<unknown | null>;
    initialFocusRef?: RefObject<ModalFocusableTarget | null>;
    returnFocusRef?: RefObject<ModalFocusableTarget | null>;
    onEscape?: () => void;
};

type WebModalRegistration = {
    id: symbol;
    order: number;
    ownerDocument: Document;
};

let nextWebModalOrder = 0;
const webModalStack: WebModalRegistration[] = [];

function registerWebModal(registration: WebModalRegistration) {
    webModalStack.push(registration);
    webModalStack.sort((left, right) => left.order - right.order);
}

function unregisterWebModal(registration: WebModalRegistration) {
    const index = webModalStack.indexOf(registration);
    if (index >= 0) webModalStack.splice(index, 1);
}

function isTopmostWebModal(registration: WebModalRegistration) {
    for (let index = webModalStack.length - 1; index >= 0; index -= 1) {
        const candidate = webModalStack[index];
        if (candidate.ownerDocument === registration.ownerDocument) return candidate === registration;
    }
    return false;
}

const FOCUSABLE_ELEMENT_SELECTOR = [
    'button:not([disabled])',
    'a[href]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
].join(','); // Covers browser controls plus focusable elements emitted by React Native Web.

function getFocusableElements(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_ELEMENT_SELECTOR))
        .filter((element) => element.getAttribute('aria-hidden') !== 'true');
}

/**
 * Contains web keyboard focus within an overlay and restores its trigger when
 * the overlay closes. Native callers can provide explicit initial/return refs.
 */
export function useModalFocusManagement({
    visible,
    containerRef,
    initialFocusRef,
    returnFocusRef,
    onEscape
}: ModalFocusManagementOptions): { focusInitial: () => void } {
    const onEscapeRef = useRef(onEscape);
    const registrationIdRef = useRef(Symbol('modal-focus-registration'));
    const registrationOrderRef = useRef(0);
    const wasVisibleRef = useRef(false);
    const automaticReturnTargetRef = useRef<HTMLElement | null>(null);
    onEscapeRef.current = onEscape;

    if (visible && !wasVisibleRef.current) {
        registrationOrderRef.current = ++nextWebModalOrder;
        if (Platform.OS === 'web' && typeof document !== 'undefined') {
            automaticReturnTargetRef.current = document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
        }
    }
    wasVisibleRef.current = visible;

    const focusInitial = useCallback(() => {
        const initialTarget = initialFocusRef?.current;
        if (typeof initialTarget?.focus === 'function') {
            initialTarget.focus();
            return;
        }

        if (Platform.OS !== 'web' || typeof HTMLElement === 'undefined') return;
        const container = containerRef.current as HTMLElement | null;
        if (!container) return;
        (getFocusableElements(container)[0] ?? container).focus();
    }, [containerRef, initialFocusRef]);

    useEffect(() => {
        if (!visible) return;
        const returnTarget = returnFocusRef?.current ?? automaticReturnTargetRef.current;

        if (Platform.OS !== 'web' || typeof document === 'undefined') {
            const frame = requestAnimationFrame(focusInitial);
            return () => {
                cancelAnimationFrame(frame);
                returnTarget?.focus?.();
            };
        }

        const container = containerRef.current as HTMLElement;
        if (!container) return;
        const ownerDocument = container.ownerDocument;
        const registration: WebModalRegistration = {
            id: registrationIdRef.current,
            order: registrationOrderRef.current,
            ownerDocument
        };
        registerWebModal(registration);
        const frame = requestAnimationFrame(focusInitial);

        function containKeyboardFocus(event: KeyboardEvent) {
            if (!isTopmostWebModal(registration)) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                onEscapeRef.current?.();
                return;
            }
            if (event.key !== 'Tab') return;

            const focusableElements = getFocusableElements(container);
            if (focusableElements.length === 0) {
                event.preventDefault();
                container.focus();
                return;
            }

            const firstElement = focusableElements[0];
            const lastElement = focusableElements[focusableElements.length - 1];
            const activeElement = ownerDocument.activeElement;
            if (event.shiftKey && (activeElement === firstElement || !container.contains(activeElement))) {
                event.preventDefault();
                lastElement.focus();
            } else if (!event.shiftKey && (activeElement === lastElement || !container.contains(activeElement))) {
                event.preventDefault();
                firstElement.focus();
            }
        }

        function containProgrammaticFocus(event: FocusEvent) {
            if (!isTopmostWebModal(registration)) return;
            if (event.target instanceof Node && container.contains(event.target)) return;
            focusInitial();
        }

        ownerDocument.addEventListener('keydown', containKeyboardFocus);
        ownerDocument.addEventListener('focusin', containProgrammaticFocus);

        return () => {
            const wasTopmost = isTopmostWebModal(registration);
            unregisterWebModal(registration);
            cancelAnimationFrame(frame);
            ownerDocument.removeEventListener('keydown', containKeyboardFocus);
            ownerDocument.removeEventListener('focusin', containProgrammaticFocus);
            if (!wasTopmost) return;
            if (returnTarget instanceof HTMLElement && !returnTarget.isConnected) return;
            returnTarget?.focus?.();
        };
    }, [containerRef, focusInitial, returnFocusRef, visible]);

    return { focusInitial };
}
