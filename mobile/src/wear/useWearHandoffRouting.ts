/** @file use Wear Handoff Routing: Drain durable watch handoffs on startup and whenever the authenticated app resumes. */

import { useCallback, useEffect, useRef } from 'react';
import { AppState, Linking } from 'react-native';
import { router } from 'expo-router';
import {
    getPendingWearHandoffs,
    getWearHandoffHref,
    getWearHandoffPublicUrl,
    markWearHandoffsHandled,
    processWearHandoffInbox,
    selectNextWearHandoffBatch
} from './handoff';

// The bridge persists messages but does not emit JS events; poll only while foregrounded for prompt handoff.
const FOREGROUND_INBOX_POLL_MS = 1_500;

/** Drain durable watch handoffs on startup and whenever the authenticated app resumes. */
export function useWearHandoffRouting(options: {
    enabled: boolean;
    serverOrigin: string;
    userId: number | null;
}): void {
    const processing = useRef(false);

    const routePendingHandoff = useCallback(async () => {
        if (!options.enabled || options.userId === null || processing.current) return;
        processing.current = true;
        try {
            await processWearHandoffInbox({
                serverOrigin: options.serverOrigin,
                userId: options.userId
            });
            const pending = await getPendingWearHandoffs(options.serverOrigin, options.userId);
            const batch = selectNextWearHandoffBatch(pending);
            if (!batch) return;
            const publicUrl = getWearHandoffPublicUrl(batch.handoff);
            const appHref = getWearHandoffHref(batch.handoff);
            if (publicUrl) await Linking.openURL(publicUrl);
            else if (appHref) router.push(appHref);
            else return;
            await markWearHandoffsHandled(
                options.serverOrigin,
                options.userId,
                batch.messageIds
            );
        } catch {
            // Native inbox or AsyncStorage retains the request for the next foreground attempt.
        } finally {
            processing.current = false;
        }
    }, [options.enabled, options.serverOrigin, options.userId]);

    useEffect(() => {
        if (!options.enabled) return;
        let poll: ReturnType<typeof setInterval> | null = null;
        const stopPolling = () => {
            if (poll !== null) clearInterval(poll);
            poll = null;
        };
        const startPolling = () => {
            if (poll !== null) return;
            void routePendingHandoff();
            poll = setInterval(() => { void routePendingHandoff(); }, FOREGROUND_INBOX_POLL_MS);
        };
        void routePendingHandoff();
        if (AppState.currentState === 'active') startPolling();
        const subscription = AppState.addEventListener('change', (state) => {
            if (state === 'active') startPolling();
            else stopPolling();
        });
        return () => {
            stopPolling();
            subscription.remove();
        };
    }, [options.enabled, routePendingHandoff]);
}
