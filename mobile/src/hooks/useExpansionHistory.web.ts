/** @file use Expansion History: Keep Router's exact state intact while Back/Forward visits the local expansion. */

import { useEffect, useId, useRef } from 'react';

const EXPANSION_HISTORY_KEY = '__calibratePageExpansion';
type Entry = { owner: string; id: string; path: string };
function readEntry(state: unknown): Entry | undefined {
    const entry = state && typeof state === 'object' ? (state as Record<string, unknown>)[EXPANSION_HISTORY_KEY] : undefined;
    if (!entry || typeof entry !== 'object') return;
    const value = entry as Partial<Entry>;
    if (typeof value.owner === 'string' && typeof value.id === 'string' && typeof value.path === 'string') return value as Entry;
}

/** Keep Router's exact state intact while Back/Forward visits the local expansion. */
export function useExpansionHistory(id: string | null | undefined, focused: boolean, onClose: () => void, onRestore: (id: string) => void): void {
    const owner = useId();
    const path = useRef('');
    const collapsing = useRef(false);
    const current = useRef({ id, focused, onClose, onRestore });
    current.current = { id, focused, onClose, onRestore };
    useEffect(() => {
        const onPop = (event: PopStateEvent) => {
            if (!current.current.focused) return;
            if (collapsing.current && window.location.pathname === path.current) {
                collapsing.current = false;
                event.stopImmediatePropagation();
                return;
            }
            const entry = readEntry(event.state);
            if (entry?.owner === owner && entry.path === window.location.pathname) {
                event.stopImmediatePropagation();
                current.current.onRestore(entry.id);
            } else if (current.current.id && window.location.pathname === path.current) {
                event.stopImmediatePropagation();
                current.current.onClose();
            }
        };
        window.addEventListener('popstate', onPop, true);
        return () => window.removeEventListener('popstate', onPop, true);
    }, [owner]);
    useEffect(() => {
        if (!focused) return;
        const entry = readEntry(window.history.state);
        if (id && entry?.owner !== owner) {
            path.current = window.location.pathname;
            window.history.pushState({ ...window.history.state, [EXPANSION_HISTORY_KEY]: { owner, id, path: path.current } }, '', window.location.href);
        } else if (!id && entry?.owner === owner) {
            collapsing.current = true;
            window.history.back();
        }
    }, [id, focused, owner]);
}
