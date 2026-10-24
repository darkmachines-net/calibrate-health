/** @file Accessible PWA connectivity/update notices positioned clear of navigation and safe areas. */

import React from 'react';
import { useWindowDimensions } from 'react-native';
import { useAppTheme } from '../theme';
import {
    browserPwaRuntime,
    PWA_NETWORK_STATES,
    PWA_UPDATE_STATES,
    type PwaRuntime,
    usePwaStatus
} from './runtime.web';

export const BROWSER_OFFLINE_MESSAGE = 'Some information may be out of date. Keep tracking locally; pending changes sync after reconnection.';
const DESKTOP_NOTICE_BREAKPOINT = 1024;
const NOTICE_EDGE_OFFSET = 16;
const DESKTOP_ACTION_CLEARANCE = 104; // Keeps persistent notices clear of the app bar and bottom contextual action.
// Clears the largest compact nav, contextual action, and spacing at 200% text.
const COMPACT_SHELL_CLEARANCE = 174;

/** Places PWA notices clear of navigation and safe-area insets for the current viewport. */
export function resolvePwaNoticePlacement(
    viewportWidth: number,
    hasCompactNavigation: boolean
): React.CSSProperties {
    const base: React.CSSProperties = {
        position: 'fixed',
        zIndex: 9000,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        pointerEvents: 'none'
    };
    if (viewportWidth >= DESKTOP_NOTICE_BREAKPOINT) {
        return {
            ...base,
            bottom: `calc(env(safe-area-inset-bottom, 0px) + ${DESKTOP_ACTION_CLEARANCE}px)`,
            right: NOTICE_EDGE_OFFSET,
            alignItems: 'flex-end'
        };
    }
    if (hasCompactNavigation) return {
        ...base,
        right: NOTICE_EDGE_OFFSET,
        bottom: `calc(env(safe-area-inset-bottom, 0px) + ${COMPACT_SHELL_CLEARANCE}px)`,
        left: NOTICE_EDGE_OFFSET,
        alignItems: 'center'
    };
    return {
        ...base,
        top: `calc(env(safe-area-inset-top, 0px) + ${NOTICE_EDGE_OFFSET}px)`,
        right: NOTICE_EDGE_OFFSET,
        left: NOTICE_EDGE_OFFSET,
        alignItems: 'center'
    };
}

/** Detects an active document dialog so global notices can avoid competing with modal interaction. */
export function isDocumentModalOpen(): boolean {
    if (typeof document === 'undefined') return false;
    return document.querySelector('[role="dialog"]') !== null;
}

function subscribeToDocumentModals(onStoreChange: () => void): () => void {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => undefined;
    const observer = new MutationObserver(onStoreChange);
    observer.observe(document.body, {
        attributes: true,
        childList: true,
        subtree: true,
        attributeFilter: ['aria-hidden', 'aria-modal', 'role']
    });
    return () => observer.disconnect();
}

function useDocumentModalOpen(): boolean {
    return React.useSyncExternalStore(subscribeToDocumentModals, isDocumentModalOpen, () => false);
}

type NoticeProps = {
    testID: string;
    role: 'alert' | 'status';
    title: string;
    detail: string;
    background: string;
    foreground: string;
    border: string;
    action?: {
        label: string;
        disabled?: boolean;
        onClick(): void;
    };
    onDismiss?: () => void;
};

function Notice({ testID, role, title, detail, background, foreground, border, action, onDismiss }: NoticeProps) {
    const style: React.CSSProperties = {
        width: 'min(440px, calc(100vw - 32px))',
        boxSizing: 'border-box',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        minHeight: 56,
        padding: '10px 12px 10px 16px',
        border: `1px solid ${border}`,
        borderRadius: 12,
        background,
        color: foreground,
        boxShadow: '0 4px 14px rgba(0, 0, 0, 0.16)',
        font: '500 14px/20px system-ui, sans-serif',
        pointerEvents: 'auto'
    };
    const copyStyle: React.CSSProperties = { minWidth: 0, flexGrow: 1, flexBasis: action || onDismiss ? '100%' : 'auto' };
    const titleStyle: React.CSSProperties = { display: 'block', fontWeight: 600 };
    const detailStyle: React.CSSProperties = { display: 'block' };
    const buttonStyle: React.CSSProperties = {
        flexShrink: 0,
        minWidth: 88,
        minHeight: 48,
        padding: '8px 14px',
        border: `1px solid ${foreground}`,
        borderRadius: 10,
        background: 'transparent',
        color: foreground,
        font: '600 14px/20px system-ui, sans-serif',
        cursor: action?.disabled ? 'wait' : 'pointer',
        opacity: action?.disabled ? 0.7 : 1
    };

    return (
        <div data-testid={testID} role={role} aria-live={role === 'alert' ? 'assertive' : 'polite'} style={style}>
            <span style={copyStyle}>
                <span style={titleStyle}>{title}</span>
                <span style={detailStyle}>{detail}</span>
            </span>
            {(action || onDismiss) && <div style={{ display: 'flex', gap: 8, width: '100%', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                {onDismiss && <button type="button" aria-label={`Dismiss ${title.toLowerCase()} notification`} style={buttonStyle} onClick={onDismiss}>Dismiss</button>}
                {action && <button type="button" disabled={action.disabled} style={buttonStyle} onClick={action.onClick}>
                    {action.label}
                </button>}
            </div>}
        </div>
    );
}

type PwaStatusBannerProps = {
    runtime?: PwaRuntime;
    showUpdateNotices?: boolean;
    hasCompactNavigation?: boolean;
};

/** Presents actionable connectivity and update notices from the external PWA runtime store. */
export function PwaStatusBanner({
    runtime = browserPwaRuntime,
    showUpdateNotices = true,
    hasCompactNavigation = false
}: PwaStatusBannerProps) {
    const theme = useAppTheme();
    const { width } = useWindowDimensions();
    const { network, update, applyUpdate, retryUpdate } = usePwaStatus(runtime);
    const [updateErrorDismissed, setUpdateErrorDismissed] = React.useState(false);
    React.useEffect(() => {
        if (update !== PWA_UPDATE_STATES.ERROR) setUpdateErrorDismissed(false);
    }, [update]);
    const modalOpen = useDocumentModalOpen();
    const containerStyle = resolvePwaNoticePlacement(width, hasCompactNavigation);
    const notices: React.ReactNode[] = [];

    if (network === PWA_NETWORK_STATES.OFFLINE) {
        notices.push(
            <Notice
                key="offline"
                testID="pwa-offline"
                role="alert"
                title="You're offline"
                detail={BROWSER_OFFLINE_MESSAGE}
                background={theme.colors.warningContainer}
                foreground={theme.colors.onWarningContainer}
                border={theme.colors.warning}
            />
        );
    } else if (network === PWA_NETWORK_STATES.BACK_ONLINE) {
        notices.push(
            <Notice
                key="online"
                testID="pwa-back-online"
                role="status"
                title="Back online"
                detail="Connection restored. Calibrate is refreshing account data."
                background={theme.colors.successContainer}
                foreground={theme.colors.onSuccessContainer}
                border={theme.colors.success}
            />
        );
    }

    if (showUpdateNotices && (update === PWA_UPDATE_STATES.READY || update === PWA_UPDATE_STATES.APPLYING)) {
        const applying = update === PWA_UPDATE_STATES.APPLYING;
        notices.push(
            <Notice
                key="update"
                testID="pwa-update-ready"
                role="status"
                title={applying ? 'Updating Calibrate' : 'Update ready'}
                detail={applying ? 'Finishing the update and refreshing...' : 'Refresh to use the latest version.'}
                background={theme.colors.infoContainer}
                foreground={theme.colors.onInfoContainer}
                border={theme.colors.info}
                action={{ label: applying ? 'Refreshing' : 'Refresh', disabled: applying, onClick: applyUpdate }}
            />
        );
    } else if (showUpdateNotices && update === PWA_UPDATE_STATES.ERROR && !updateErrorDismissed) {
        notices.push(
            <Notice
                key="update-error"
                testID="pwa-update-error"
                role="alert"
                title="Update failed"
                detail="Calibrate could not install the update. Check your connection and try again."
                background={theme.colors.dangerContainer}
                foreground={theme.colors.onDangerContainer}
                border={theme.colors.danger}
                action={{ label: 'Try again', onClick: () => void retryUpdate() }}
                onDismiss={() => setUpdateErrorDismissed(true)}
            />
        );
    }

    if (notices.length === 0 || modalOpen) return null;
    return <div data-testid="pwa-status-container" style={containerStyle}>{notices}</div>;
}
