/** @file Calendar Modal: Web portal avoids React Native Modal painting and hit-testing inconsistencies in browsers. */

import React, { useRef } from 'react';
import { createPortal } from 'react-dom';
import { useWindowDimensions } from 'react-native';
import { useAppTheme } from '../theme';
import { useModalFocusManagement } from '../hooks/useModalFocusManagement';
import { ADAPTIVE_DIALOG_BREAKPOINT, STANDARD_DIALOG_WIDTH } from './BottomSheetModal';
import type { CalendarModalProps } from './CalendarModal';

const CALENDAR_MODAL_Z_INDEX = 1_000; // Keeps the date picker above the fixed web app shell.
const CALENDAR_SHEET_MAX_HEIGHT = '94vh'; // Leaves context around the modal on short browser viewports.
/** Web portal avoids React Native Modal painting and hit-testing inconsistencies in browsers. */
export const CalendarModal: React.FC<CalendarModalProps> = ({
    visible,
    onRequestClose,
    children
}) => {
    const theme = useAppTheme();
    const { width: viewportWidth } = useWindowDimensions();
    const isDialog = viewportWidth >= ADAPTIVE_DIALOG_BREAKPOINT;
    const sheetRef = useRef<HTMLDivElement>(null);

    useModalFocusManagement({
        visible,
        containerRef: sheetRef,
        onEscape: onRequestClose
    });

    if (!visible || typeof document === 'undefined') return null;

    return createPortal(
        <div
            style={{
                position: 'fixed',
                inset: 0,
                zIndex: CALENDAR_MODAL_Z_INDEX,
                display: 'flex',
                alignItems: 'center',
                justifyContent: isDialog ? 'center' : 'flex-end',
                padding: isDialog ? theme.spacing.lg : 0
            }}
        >
            <div
                aria-hidden="true"
                onClick={onRequestClose}
                style={{
                    position: 'absolute',
                    inset: 0,
                    width: '100%',
                    height: '100%',
                    padding: 0,
                    border: 0,
                    background: theme.colors.scrim,
                    cursor: 'default'
                }}
            />
            <div
                ref={sheetRef}
                aria-label="Calendar"
                aria-modal="true"
                role="dialog"
                tabIndex={-1}
                style={{
                    position: 'relative',
                    boxSizing: 'border-box',
                    width: isDialog ? `min(${STANDARD_DIALOG_WIDTH}px, 100%)` : '100%',
                    maxHeight: isDialog
                        ? `min(${CALENDAR_SHEET_MAX_HEIGHT}, calc(100% - ${theme.spacing.lg * 2}px))`
                        : CALENDAR_SHEET_MAX_HEIGHT,
                    overflowY: 'auto',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    padding: `${theme.spacing.md}px ${theme.spacing.lg}px max(${theme.spacing.lg}px, env(safe-area-inset-bottom))`,
                    border: isDialog
                        ? `${theme.stroke.control}px solid ${theme.colors.outlineVariant}`
                        : undefined,
                    borderTop: `${theme.stroke.control}px solid ${theme.colors.outlineVariant}`,
                    borderRadius: isDialog ? theme.radius.sheet : 0,
                    borderTopLeftRadius: theme.radius.sheet,
                    borderTopRightRadius: theme.radius.sheet,
                    background: theme.colors.surfaceContainerLow,
                    boxShadow: '0 -8px 30px rgba(0, 0, 0, 0.18)'
                }}
            >
                <div
                    aria-hidden="true"
                    style={{
                        width: 44,
                        height: 4,
                        margin: `0 auto ${theme.spacing.md}px`,
                        borderRadius: theme.radius.pill,
                        background: theme.colors.outline
                    }}
                />
                {children}
            </div>
        </div>,
        document.body
    );
};
