/** @file Browser chart drag, horizontal wheel handling, and tap/drag arbitration. */

import { useEffect, useLayoutEffect, useRef } from 'react';
import type { ComponentRef } from 'react';
import type { View } from 'react-native';
import type { WeightTrendPanCallbacks, WeightTrendPanBindings } from './useWeightTrendPan';

// Delay capture until the pointer has clearly moved horizontally; vertical touch scrolling stays native.
const DRAG_THRESHOLD = 6;
// Group a burst of trackpad events into one pan, then snap to a whole date.
const WHEEL_IDLE_MS = 140;
// Convert DOM_DELTA_LINE events from shift-wheel devices into approximate CSS pixels.
const WHEEL_LINE_PX = 16;

/** Attaches pointer and wheel interactions to the chart while keeping a normal tap selectable. */
export function useWeightTrendPan(callbacks: WeightTrendPanCallbacks): WeightTrendPanBindings {
    const ref = useRef<ComponentRef<typeof View>>(null);
    const handlers = useRef(callbacks);
    useLayoutEffect(() => { handlers.current = callbacks; }, [callbacks]);
    useEffect(() => {
        const plot = ref.current as unknown as HTMLElement | null;
        if (!plot) return;
        plot.style.touchAction = 'pan-y pinch-zoom';
        plot.style.userSelect = 'none';
        plot.style.cursor = 'grab';
        let pointer: { id: number; x: number; y: number; dragging: boolean } | null = null;
        let suppressClick = false;
        let wheelTimer: ReturnType<typeof setTimeout> | undefined;
        let wheelPixels = 0;

        const finishWheel = () => {
            if (wheelTimer === undefined) return;
            clearTimeout(wheelTimer);
            wheelTimer = undefined;
            wheelPixels = 0;
            handlers.current.end();
        };
        const pointerDown = (event: PointerEvent) => {
            if (!event.isPrimary || event.button !== 0) return;
            finishWheel();
            suppressClick = false;
            pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, dragging: false };
        };
        const pointerMove = (event: PointerEvent) => {
            if (!pointer || pointer.id !== event.pointerId) return;
            const dx = event.clientX - pointer.x;
            if (!pointer.dragging) {
                if (Math.abs(dx) < DRAG_THRESHOLD || Math.abs(dx) <= Math.abs(event.clientY - pointer.y)) return;
                pointer.dragging = true;
                suppressClick = true;
                plot.setPointerCapture(event.pointerId);
                plot.style.cursor = 'grabbing';
                handlers.current.begin();
            }
            handlers.current.move(dx);
        };
        const pointerEnd = (event: PointerEvent) => {
            if (!pointer || pointer.id !== event.pointerId) return;
            if (pointer.dragging) handlers.current.end();
            pointer = null;
            plot.style.cursor = 'grab';
        };
        const pointerLeave = (event: PointerEvent) => {
            if (!pointer?.dragging) pointerEnd(event);
        };
        const click = (event: MouseEvent) => {
            if (!suppressClick || event.detail === 0) return;
            event.preventDefault();
            event.stopPropagation();
        };
        const wheel = (event: WheelEvent) => {
            if (pointer || event.ctrlKey) return;
            const delta = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
            if (!delta || (!event.shiftKey && Math.abs(delta) < Math.abs(event.deltaY))) return;
            event.preventDefault();
            if (wheelTimer === undefined) handlers.current.begin();
            else clearTimeout(wheelTimer);
            const scale = event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? plot.clientWidth : 1;
            wheelPixels -= delta * scale;
            handlers.current.move(wheelPixels);
            wheelTimer = setTimeout(finishWheel, WHEEL_IDLE_MS);
        };
        plot.addEventListener('pointerdown', pointerDown);
        plot.addEventListener('pointermove', pointerMove);
        plot.addEventListener('pointerup', pointerEnd);
        plot.addEventListener('pointercancel', pointerEnd);
        plot.addEventListener('lostpointercapture', pointerEnd);
        plot.addEventListener('pointerleave', pointerLeave);
        plot.addEventListener('click', click, true);
        plot.addEventListener('wheel', wheel, { passive: false });
        return () => {
            clearTimeout(wheelTimer);
            plot.removeEventListener('pointerdown', pointerDown);
            plot.removeEventListener('pointermove', pointerMove);
            plot.removeEventListener('pointerup', pointerEnd);
            plot.removeEventListener('pointercancel', pointerEnd);
            plot.removeEventListener('lostpointercapture', pointerEnd);
            plot.removeEventListener('pointerleave', pointerLeave);
            plot.removeEventListener('click', click, true);
            plot.removeEventListener('wheel', wheel);
        };
    }, []);
    return { ref };
}
