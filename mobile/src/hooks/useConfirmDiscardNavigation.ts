/** @file use Confirm Discard Navigation: Preserves a routed editor's unsaved-change confirmation for shell, browser, gesture, and in-page navigation. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { useNavigation } from 'expo-router';
import { useIsFocused, usePreventRemove } from 'expo-router/build/react-navigation/core';
import { confirmDiscardChanges } from '../components/confirmDiscardChanges';
import { useBrowserDiscardNavigation } from './useBrowserDiscardNavigation';
import { registerNavigationGuard, type PrepareNavigation } from '../navigation/guardedNavigation';

type Navigate = () => void;

/**
 * Preserves a routed editor's unsaved-change confirmation for shell, browser,
 * gesture, and in-page navigation.
 */
export function useConfirmDiscardNavigation(
    isDirty: boolean,
    isNavigationBlocked = false,
    onDiscard?: () => void
) {
    const navigation = useNavigation();
    const isFocused = useIsFocused();
    const discardRef = useRef(onDiscard);
    discardRef.current = onDiscard;
    const confirmationPendingRef = useRef(false);
    const pendingNavigationRef = useRef<Navigate | null>(null);
    const [navigationAllowed, setNavigationAllowed] = useState(false);
    const shouldPreventRemoval = isFocused && (isDirty || isNavigationBlocked) && !navigationAllowed;

    const allowNavigation = useCallback((navigate: Navigate) => {
        pendingNavigationRef.current = navigate;
        setNavigationAllowed(true);
    }, []);

    useEffect(() => {
        if (!navigationAllowed) return;
        const navigate = pendingNavigationRef.current;
        pendingNavigationRef.current = null;
        navigate?.();
    }, [navigationAllowed]);

    useEffect(() => {
        if (!isFocused || (!isDirty && !isNavigationBlocked)) setNavigationAllowed(false);
    }, [isDirty, isFocused, isNavigationBlocked]);

    const requestNavigation = useCallback(async (navigate: Navigate, prepare?: PrepareNavigation) => {
        if (isNavigationBlocked || confirmationPendingRef.current) return;
        confirmationPendingRef.current = true;
        try {
            if (isDirty && !await confirmDiscardChanges()) return;
            // A failed prerequisite must leave both the editor and its guard intact.
            if (prepare && !await prepare()) return;
            if (isDirty) discardRef.current?.();
            allowNavigation(navigate);
        } finally {
            confirmationPendingRef.current = false;
        }
    }, [allowNavigation, isDirty, isNavigationBlocked]);

    useBrowserDiscardNavigation(shouldPreventRemoval, requestNavigation);

    useEffect(() => {
        if (!shouldPreventRemoval) return;
        return registerNavigationGuard(requestNavigation);
    }, [requestNavigation, shouldPreventRemoval]);

    usePreventRemove(shouldPreventRemoval, ({ data }) => {
        void requestNavigation(() => navigation.dispatch(data.action));
    });

    useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined' || !shouldPreventRemoval) return;
        const handleBeforeUnload = (event: BeforeUnloadEvent) => {
            event.preventDefault();
            event.returnValue = '';
        };
        window.addEventListener('beforeunload', handleBeforeUnload);
        return () => window.removeEventListener('beforeunload', handleBeforeUnload);
    }, [shouldPreventRemoval]);

    return { allowNavigation, requestNavigation };
}
