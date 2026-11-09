/** @file Browser viewport measurements for surfaces that follow keyboard resizing and panning. */

import { useSyncExternalStore } from 'react';

function subscribe(onStoreChange: () => void): () => void {
    const viewport = window.visualViewport;
    if (!viewport) {
        window.addEventListener('resize', onStoreChange);
        return () => window.removeEventListener('resize', onStoreChange);
    }

    viewport.addEventListener('resize', onStoreChange);
    viewport.addEventListener('scroll', onStoreChange);
    return () => {
        viewport.removeEventListener('resize', onStoreChange);
        viewport.removeEventListener('scroll', onStoreChange);
    };
}

function getSnapshot(): number {
    return Math.round(window.visualViewport?.height ?? window.innerHeight);
}

function getOffsetTop(): number {
    return window.visualViewport?.offsetTop ?? 0;
}

/** Uses the browser's unobscured viewport rather than the layout viewport behind a software keyboard. */
export function useVisualViewportHeight(): number | undefined {
    return useSyncExternalStore(subscribe, getSnapshot, () => undefined);
}

/** Follows the visible viewport when the browser pans the page to reveal a focused input. */
export function useVisualViewportOffsetTop(): number {
    return useSyncExternalStore(subscribe, getOffsetTop, () => 0);
}
