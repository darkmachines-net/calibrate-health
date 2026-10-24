/** @file use Notification Tap Routing: Route push taps safely and reconcile foreground/native updates with the in-app notification cache. */

import { useEffect, useRef } from 'react';
import { router, type Href } from 'expo-router';
import { getNotificationAction, getNotificationResponseActionUrl } from './workflow';

type NotificationResponseLike = {
    actionIdentifier?: string;
    notification: {
        request: {
            identifier: string;
            content: { data?: unknown };
        };
    };
};

/** Route push taps safely and reconcile foreground/native updates with the in-app notification cache. */
export function useNotificationTapRouting(enabled: boolean, onNotificationUpdate?: () => void): void {
    const handledResponses = useRef(new Set<string>());

    useEffect(() => {
        if (!enabled) return;
        let active = true;
        let removeListeners: (() => void) | undefined;

        const handleResponse = (response: NotificationResponseLike) => {
            if (!active) return;
            onNotificationUpdate?.();
            const responseKey = `${response.notification.request.identifier}:${response.actionIdentifier ?? 'default'}`;
            if (handledResponses.current.has(responseKey)) return;
            handledResponses.current.add(responseKey);

            const data = response.notification.request.content.data;
            const actionUrl = getNotificationResponseActionUrl(data, response.actionIdentifier);
            router.push(getNotificationAction(actionUrl).href as Href);
        };

        void import('expo-notifications').then(async (Notifications) => {
            if (!active) return;
            const responseSubscription = Notifications.addNotificationResponseReceivedListener(handleResponse);
            const receivedSubscription = Notifications.addNotificationReceivedListener(() => {
                if (active) onNotificationUpdate?.();
            });
            removeListeners = () => {
                responseSubscription.remove();
                receivedSubscription.remove();
            };

            const lastResponse = await Notifications.getLastNotificationResponseAsync();
            if (lastResponse) {
                handleResponse(lastResponse);
                await Notifications.clearLastNotificationResponseAsync();
            }
        }).catch(() => {
            // Notification routing is an enhancement; normal in-app navigation remains available.
        });

        return () => {
            active = false;
            removeListeners?.();
        };
    }, [enabled, onNotificationUpdate]);
}
