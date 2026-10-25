/** @file Cross-platform modal sheet layout, focus isolation, stacked-dialog accessibility, and dismissal behavior. */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    Animated,
    Easing,
    KeyboardAvoidingView,
    Modal,
    Platform,
    Pressable,
    StyleSheet,
    View,
    useWindowDimensions,
    type StyleProp,
    type ViewStyle
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { webSafeAreaPadding } from '../layout/webSafeArea';
import {
    SUPPORTED_MODAL_ORIENTATIONS,
    TABLET_LAYOUT_BREAKPOINT
} from '../layout/adaptiveLayout';
import { type AppTheme, useAppTheme } from '../theme';
import { useReducedMotionPreference } from '../hooks/useReducedMotionPreference';
import { useVisualViewportHeight } from '../hooks/useVisualViewportHeight';
import { useModalFocusManagement, type ModalFocusableTarget } from '../hooks/useModalFocusManagement';
import { getKeyboardAvoidingBehavior } from '../utils/keyboard';
import { AppIconButton } from './AppIconButton';
import { AppText } from './AppText';
import { confirmDiscardChanges } from './confirmDiscardChanges';
import { KeyboardAwareScrollView } from './KeyboardAwareScrollView';

export type BottomSheetModalSize = 'standard' | 'wide';

export type BottomSheetModalProps = {
    visible: boolean;
    onRequestClose: () => void;
    children: React.ReactNode;
    maxHeight?: ViewStyle['maxHeight'];
    accessibilityLabel?: string;
    showCloseButton?: boolean;
    showHandle?: boolean;
    scrollable?: boolean;
    footer?: React.ReactNode;
    dismissDisabled?: boolean;
    contentKey?: React.Key;
    onShow?: () => void;
    size?: BottomSheetModalSize;
    title?: string;
    description?: string;
    initialFocusRef?: React.RefObject<ModalFocusableTarget | null>;
    returnFocusRef?: React.RefObject<ModalFocusableTarget | null>;
    isDirty?: boolean;
    confirmDismiss?: () => boolean | Promise<boolean>;
    contentStyle?: StyleProp<ViewStyle>;
    revealFocusedInputOnFocus?: boolean;
};

export const ADAPTIVE_DIALOG_BREAKPOINT = TABLET_LAYOUT_BREAKPOINT;
export const STANDARD_DIALOG_WIDTH = 640;
const WIDE_DIALOG_WIDTH = 800;
const DIALOG_TRANSLATE_Y = 32; // Keeps centered dialogs from traveling like edge-anchored sheets.
const BACKDROP_OPEN_DURATION_MS = 160; // Lets the sheet lead slightly as the modal context appears.
const BACKDROP_CLOSE_DURATION_MS = 140; // Clears the scrim promptly after dismissal begins.
const SHEET_OPEN_DURATION_MS = 280; // Gives full-height bottom travel a smooth deceleration.
const SHEET_CLOSE_DURATION_MS = 200; // Keeps dismissal responsive while returning below the viewport.
const WEB_FIXED_POSITION = 'fixed' as ViewStyle['position']; // Keeps portal sheets anchored while the underlying web page is scrolled.
const SHEET_CLOSE_ROW_MAX_WIDTH = 800; // Aligns an optional close action with wide detail-sheet content.
let activeWebBottomSheets = 0;
let webAppRoot: HTMLElement | null = null;
let webAppRootAriaHidden: string | null = null;
let webAppRootWasInert = false;
type WebBottomSheetContainer = Pick<HTMLElement, 'getAttribute' | 'querySelector' | 'removeAttribute'>;
type WebBottomSheetDocument = {
    body: Node;
    querySelectorAll: (selector: string) => Iterable<WebBottomSheetContainer>;
};
type WebModalAccessibilityObserver = Pick<MutationObserver, 'disconnect' | 'observe'>;
type WebModalAccessibilityObserverFactory = (callback: MutationCallback) => WebModalAccessibilityObserver;
let webModalAccessibilityObserver: WebModalAccessibilityObserver | null = null;

/**
 * React Native Web leaves aria-modal on inactive stacked Modal containers after
 * removing their dialog role. Keep the inactive wrapper out of the accessibility
 * tree contract while the active BottomSheet panel remains the modal dialog.
 */
function normalizeInactiveWebBottomSheetContainers(documentRoot: Pick<WebBottomSheetDocument, 'querySelectorAll'>) {
    for (const element of documentRoot.querySelectorAll('[aria-modal="true"]')) {
        const role = element.getAttribute('role');
        if (role === 'dialog' || role === 'alertdialog') continue;
        if (element.querySelector('[data-testid="adaptive-dialog-panel"]')) {
            element.removeAttribute('aria-modal');
        }
    }
}

/** Normalizes inactive web modal containers and observes future role and tree changes. */
export function createWebBottomSheetContainerObserver(
    documentRoot: WebBottomSheetDocument,
    observerFactory: WebModalAccessibilityObserverFactory
): WebModalAccessibilityObserver {
    normalizeInactiveWebBottomSheetContainers(documentRoot);
    const observer = observerFactory(() => normalizeInactiveWebBottomSheetContainers(documentRoot));
    observer.observe(documentRoot.body, {
        attributes: true,
        attributeFilter: ['aria-modal', 'role'],
        childList: true,
        subtree: true
    });
    return observer;
}

function observeWebBottomSheetContainers() {
    if (webModalAccessibilityObserver || typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
    webModalAccessibilityObserver = createWebBottomSheetContainerObserver(
        document,
        (callback) => new MutationObserver(callback)
    );
}
function hideWebAppFromModalAccessibility(): (() => void) | undefined {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const appRoot = document.getElementById('root');
    if (!appRoot) return;
    if (activeWebBottomSheets === 0) {
        webAppRoot = appRoot;
        webAppRootAriaHidden = appRoot.getAttribute('aria-hidden');
        webAppRootWasInert = appRoot.inert;
        appRoot.setAttribute('aria-hidden', 'true');
        appRoot.inert = true;
    }
    activeWebBottomSheets += 1;
    observeWebBottomSheetContainers();
    return () => {
        activeWebBottomSheets = Math.max(0, activeWebBottomSheets - 1);
        if (activeWebBottomSheets > 0) return;
        webModalAccessibilityObserver?.disconnect();
        webModalAccessibilityObserver = null;
        if (!webAppRoot) return;
        if (webAppRootAriaHidden === null) webAppRoot.removeAttribute('aria-hidden');
        else webAppRoot.setAttribute('aria-hidden', webAppRootAriaHidden);
        webAppRoot.inert = webAppRootWasInert;
        webAppRoot = null;
        webAppRootAriaHidden = null;
        webAppRootWasInert = false;
    };
}

/** React Native Web portals need a pixel height because percentage heights resolve against a zero-height wrapper. */
export function resolveFixedSheetHeight(
    maxHeight: ViewStyle['maxHeight'],
    visualViewportHeight: number | undefined
): ViewStyle['height'] {
    if (visualViewportHeight === undefined || typeof maxHeight !== 'string') return maxHeight;
    const percentageMatch = maxHeight.match(/^(\d+(?:\.\d+)?)%$/);
    if (!percentageMatch) return maxHeight;
    return visualViewportHeight * (Number(percentageMatch[1]) / 100);
}

/** Chooses a desktop dialog width bounded by viewport insets, leaving phone sheets unconstrained. */
export function resolveAdaptiveDialogWidth(
    viewportWidth: number,
    size: BottomSheetModalSize,
    horizontalInset: number
): number | undefined {
    if (viewportWidth < ADAPTIVE_DIALOG_BREAKPOINT) return undefined;
    const preferredWidth = size === 'wide' ? WIDE_DIALOG_WIDTH : STANDARD_DIALOG_WIDTH;
    return Math.min(preferredWidth, Math.max(0, viewportWidth - (horizontalInset * 2)));
}

/** Mobile sheets begin below the viewport; centered dialogs use a shorter transition. */
export function resolveSheetEntranceOffset(viewportHeight: number, isDialog: boolean): number {
    return isDialog ? DIALOG_TRANSLATE_Y : Math.max(0, viewportHeight);
}

/**
 * Presents as a mobile bottom sheet or a bounded dialog on larger viewports.
 * Keep it to a short contextual task, picker, preview, or confirmation; use a
 * registered route for browsable, multi-section, or independently managed work.
 */
export const BottomSheetModal: React.FC<BottomSheetModalProps> = ({
    visible,
    onRequestClose,
    children,
    maxHeight = '88%',
    accessibilityLabel = 'Details',
    showCloseButton = false,
    showHandle = true,
    scrollable = true,
    footer,
    dismissDisabled = false,
    contentKey,
    onShow,
    size = 'standard',
    title,
    description,
    initialFocusRef,
    returnFocusRef,
    isDirty = false,
    confirmDismiss,
    contentStyle,
    revealFocusedInputOnFocus = false
}) => {
    const insets = useSafeAreaInsets();
    const theme = useAppTheme();
    const styles = React.useMemo(() => createStyles(theme), [theme]);
    const reduceMotion = useReducedMotionPreference();
    const visualViewportHeight = useVisualViewportHeight();
    const { width: viewportWidth, height: viewportHeight } = useWindowDimensions();
    const [shouldRender, setShouldRender] = useState(visible);
    const [presentationReady, setPresentationReady] = useState(false);
    const backdropOpacity = useRef(new Animated.Value(0)).current;
    const sheetProgress = useRef(new Animated.Value(1)).current;
    const sheetRef = useRef<React.ComponentRef<typeof View>>(null);
    const dismissRequestPendingRef = useRef(false);
    const titleId = React.useId();
    const descriptionId = React.useId();
    const isDialog = viewportWidth >= ADAPTIVE_DIALOG_BREAKPOINT;
    const dialogHorizontalInset = Math.max(theme.spacing.lg, insets.left, insets.right);
    const dialogVerticalInset = Math.max(theme.spacing.lg, insets.top, insets.bottom);
    const dialogWidth = resolveAdaptiveDialogWidth(viewportWidth, size, dialogHorizontalInset);
    const sheetWidth = dialogWidth ?? Math.max(0, viewportWidth - insets.left - insets.right);
    const sheetAlignment: ViewStyle['alignSelf'] = isDialog ? 'center' : 'flex-start';
    const sheetLeftInset = isDialog ? 0 : insets.left;
    const modalAccessibilityLabel = title ?? accessibilityLabel;

    const animateIn = useCallback(() => {
        Animated.parallel([
            Animated.timing(backdropOpacity, {
                toValue: 1,
                duration: reduceMotion ? 0 : BACKDROP_OPEN_DURATION_MS,
                easing: Easing.out(Easing.ease),
                useNativeDriver: true
            }),
            Animated.timing(sheetProgress, {
                toValue: 0,
                duration: reduceMotion ? 0 : SHEET_OPEN_DURATION_MS,
                easing: Easing.out(Easing.cubic),
                useNativeDriver: true
            })
        ]).start();
    }, [backdropOpacity, reduceMotion, sheetProgress]);

    const requestDismiss = useCallback(async () => {
        if (dismissDisabled || dismissRequestPendingRef.current) return;
        dismissRequestPendingRef.current = true;
        try {
            if (isDirty) {
                const shouldDismiss = await (confirmDismiss?.() ?? confirmDiscardChanges());
                if (!shouldDismiss) return;
            }
            onRequestClose();
        } finally {
            dismissRequestPendingRef.current = false;
        }
    }, [confirmDismiss, dismissDisabled, isDirty, onRequestClose]);

    useEffect(() => {
        if (!visible) return;
        return hideWebAppFromModalAccessibility();
    }, [visible]);
    const { focusInitial } = useModalFocusManagement({
        visible,
        containerRef: sheetRef,
        initialFocusRef,
        returnFocusRef
    });

    useEffect(() => {
        if (visible) {
            if (!shouldRender) {
                backdropOpacity.setValue(0);
                sheetProgress.setValue(1);
                setPresentationReady(false);
                setShouldRender(true);
                return;
            }
            // Native Modal content must finish mounting at its hidden position before
            // the native-driver animation starts, or Android can paint one resting frame.
            if (presentationReady) animateIn();
            return;
        }

        if (!shouldRender) return;

        Animated.parallel([
            Animated.timing(backdropOpacity, {
                toValue: 0,
                duration: reduceMotion ? 0 : BACKDROP_CLOSE_DURATION_MS,
                easing: Easing.in(Easing.ease),
                useNativeDriver: true
            }),
            Animated.timing(sheetProgress, {
                toValue: 1,
                duration: reduceMotion ? 0 : SHEET_CLOSE_DURATION_MS,
                easing: Easing.in(Easing.cubic),
                useNativeDriver: true
            })
        ]).start(({ finished }) => {
            if (finished) {
                setPresentationReady(false);
                setShouldRender(false);
            }
        });
    }, [animateIn, backdropOpacity, presentationReady, reduceMotion, sheetProgress, shouldRender, visible]);

    if (!shouldRender) return null;

    const translateY = sheetProgress.interpolate({
        inputRange: [0, 1],
        outputRange: [0, resolveSheetEntranceOffset(viewportHeight, isDialog)]
    });
    let sheetTopControl: React.ReactNode = null;
    if (showCloseButton) {
        sheetTopControl = (
            <View style={styles.closeRow}>
                <AppIconButton
                    icon="close"
                    accessibilityLabel={`Close ${modalAccessibilityLabel.toLowerCase()}`}
                    variant="ghost"
                    disabled={dismissDisabled}
                    onPress={() => {
                        void requestDismiss();
                    }}
                />
            </View>
        );
    } else if (showHandle && !isDialog) {
        sheetTopControl = <View accessible={false} aria-hidden style={styles.handle} />;
    }
    const fixedSheetHeight = resolveFixedSheetHeight(maxHeight, visualViewportHeight);
    const dialogHeight = resolveFixedSheetHeight(maxHeight, visualViewportHeight ?? viewportHeight);
    const boundedDialogHeight = typeof dialogHeight === 'number'
        ? Math.min(dialogHeight, Math.max(0, (visualViewportHeight ?? viewportHeight) - (dialogVerticalInset * 2)))
        : dialogHeight;
    const usesFixedSheetHeight = !scrollable || Boolean(footer);
    let panelMaxHeight: ViewStyle['maxHeight'] = maxHeight;
    let panelHeight: ViewStyle['height'];
    if (isDialog) {
        panelMaxHeight = boundedDialogHeight;
        if (usesFixedSheetHeight) panelHeight = boundedDialogHeight;
    } else if (usesFixedSheetHeight) {
        panelMaxHeight = fixedSheetHeight;
        panelHeight = fixedSheetHeight;
    }
    if (Platform.OS === 'web' && (typeof panelMaxHeight === 'number' || typeof panelMaxHeight === 'string')) {
        // Portaled sheets must also fit inside the root's CSS safe-area padding.
        const maximum = typeof panelMaxHeight === 'number' ? `${panelMaxHeight}px` : panelMaxHeight;
        panelMaxHeight = `min(${maximum}, 100%)` as ViewStyle['maxHeight'];
    }
    const modalHeader = title || description ? (
        <View style={styles.modalHeader}>
            {title && (
                <AppText nativeID={titleId} variant="section" accessibilityRole="header">
                    {title}
                </AppText>
            )}
            {description && (
                <AppText nativeID={descriptionId} variant="body" style={styles.modalDescription}>
                    {description}
                </AppText>
            )}
        </View>
    ) : null;

    return (
        <Modal
            visible
            transparent
            animationType="none"
            presentationStyle="overFullScreen"
            hardwareAccelerated={Platform.OS === 'android'}
            supportedOrientations={SUPPORTED_MODAL_ORIENTATIONS}
            onRequestClose={() => {
                void requestDismiss();
            }}
            onShow={() => {
                if (!visible) return;
                setPresentationReady(true);
                focusInitial();
                onShow?.();
            }}
        >
            <KeyboardAvoidingView
                testID="bottom-sheet-root"
                behavior={getKeyboardAvoidingBehavior(Platform.OS)}
                style={[
                    styles.root,
                    isDialog && styles.dialogRoot,
                    isDialog && { paddingVertical: dialogVerticalInset },
                    webSafeAreaPadding(isDialog ? theme.spacing.lg : 0),
                    visualViewportHeight !== undefined && styles.webViewportRoot,
                    visualViewportHeight !== undefined && { height: visualViewportHeight }
                ]}
            >
                <Pressable
                    testID="bottom-sheet-backdrop"
                    accessible={false}
                    focusable={false}
                    importantForAccessibility="no-hide-descendants"
                    aria-hidden
                    disabled={dismissDisabled}
                    style={[StyleSheet.absoluteFill, styles.backdropPressable]}
                    onPress={() => {
                        void requestDismiss();
                    }}
                >
                    <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]} />
                </Pressable>
                <Animated.View
                    ref={sheetRef}
                    testID="adaptive-dialog-panel"
                    accessibilityLabel={Platform.OS === 'web' ? undefined : modalAccessibilityLabel}
                    accessibilityViewIsModal
                    role="dialog"
                    aria-modal
                    aria-labelledby={title ? titleId : undefined}
                    aria-describedby={description ? descriptionId : undefined}
                    aria-label={title ? undefined : modalAccessibilityLabel}
                    tabIndex={Platform.OS === 'web' ? -1 : undefined}
                    style={[
                        styles.sheet,
                        isDialog && styles.dialog,
                        usesFixedSheetHeight && styles.fixedHeightSheet,
                        {
                            width: sheetWidth,
                            alignSelf: sheetAlignment,
                            marginLeft: sheetLeftInset,
                            maxHeight: panelMaxHeight,
                            height: panelHeight,
                            opacity: presentationReady ? 1 : 0,
                            transform: [{ translateY }]
                        }
                    ]}
                >
                    {sheetTopControl && (
                        <View testID="bottom-sheet-fixed-controls" style={styles.topControls}>
                            {sheetTopControl}
                        </View>
                    )}
                    {scrollable ? (
                        <KeyboardAwareScrollView
                            key={contentKey}
                            testID="bottom-sheet-scroll"
                            style={styles.scroll}
                            revealFocusedInputOnFocus={revealFocusedInputOnFocus}
                            contentContainerStyle={[
                                styles.content,
                                {
                                    paddingTop: sheetTopControl ? theme.spacing.sm : theme.spacing.md,
                                    paddingBottom: footer
                                        ? 0
                                        : Math.max(theme.spacing.lg, insets.bottom + theme.spacing.sm)
                                },
                                contentStyle
                            ]}
                        >
                            {modalHeader}
                            {children}
                        </KeyboardAwareScrollView>
                    ) : (
                        <View
                            testID="bottom-sheet-content"
                            style={[
                                styles.content,
                                styles.fixedContent,
                                {
                                    paddingTop: sheetTopControl ? theme.spacing.sm : theme.spacing.md,
                                    paddingBottom: footer
                                        ? 0
                                        : Math.max(theme.spacing.lg, insets.bottom + theme.spacing.sm)
                                },
                                contentStyle
                            ]}
                        >
                            {modalHeader}
                            {children}
                        </View>
                    )}
                    {footer && (
                        <View
                            style={[
                                styles.footer,
                                { paddingBottom: Math.max(theme.spacing.md, insets.bottom + theme.spacing.sm) }
                            ]}
                        >
                            {footer}
                        </View>
                    )}
                </Animated.View>
            </KeyboardAvoidingView>
        </Modal>
    );
};

function createStyles(theme: AppTheme) {
    return StyleSheet.create({
    root: {
        flex: 1,
        justifyContent: 'flex-end'
    },
    dialogRoot: {
        justifyContent: 'center',
        alignItems: 'center',
    },
    webViewportRoot: {
        flexGrow: 0,
        flexShrink: 0,
        flexBasis: 'auto',
        width: '100%',
        position: WEB_FIXED_POSITION,
        top: 0,
        left: 0,
        right: 0
    },
    backdrop: {
        flex: 1,
        backgroundColor: theme.colors.scrim
    },
    backdropPressable: {
        zIndex: 0
    },
    sheet: {
        ...theme.shadows.raised,
        position: 'relative',
        zIndex: 1,
        width: '100%',
        maxWidth: '100%',
        overflow: 'hidden',
        borderTopLeftRadius: theme.radius.sheet,
        borderTopRightRadius: theme.radius.sheet,
        backgroundColor: theme.colors.surfaceContainerLow,
        borderColor: theme.colors.outlineVariant,
        borderTopWidth: StyleSheet.hairlineWidth
    },
    dialog: {
        borderWidth: theme.stroke.control,
        borderRadius: theme.radius.sheet
    },
    topControls: {
        width: '100%',
        paddingHorizontal: theme.spacing.lg,
        paddingTop: theme.spacing.sm,
        backgroundColor: theme.colors.surfaceContainerLow
    },
    scroll: {
        flexShrink: 1
    },
    fixedHeightSheet: {
        minHeight: 0
    },
    content: {
        gap: theme.spacing.md,
        paddingHorizontal: theme.spacing.lg
    },
    modalHeader: {
        gap: theme.spacing.xs
    },
    modalDescription: {
        color: theme.colors.onSurfaceVariant
    },
    closeRow: {
        alignSelf: 'center',
        width: '100%',
        maxWidth: SHEET_CLOSE_ROW_MAX_WIDTH,
        minHeight: theme.interaction.minimumTouchTarget,
        alignItems: 'flex-end',
        justifyContent: 'center'
    },
    fixedContent: {
        flex: 1,
        minHeight: 0
    },
    footer: {
        gap: theme.spacing.sm,
        paddingHorizontal: theme.spacing.lg,
        paddingTop: theme.spacing.md,
        borderTopColor: theme.colors.outlineVariant,
        borderTopWidth: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.surfaceContainerLow
    },
    handle: {
        alignSelf: 'center',
        width: 44,
        height: 4,
        borderRadius: theme.radius.pill,
        backgroundColor: theme.colors.outline
    }
    });
}
