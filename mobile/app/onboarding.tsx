import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, findNodeHandle, KeyboardAvoidingView, Platform, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Redirect } from 'expo-router';
import type { UserClientPayload } from '@calibrate/api-client';
import { useAuth } from '../src/auth/AuthContext';
import { restrictedAccountRoute } from '../src/auth/accountAccess';
import { AppButton } from '../src/components/AppButton';
import { AppNotice } from '../src/components/AppNotice';
import { AppText } from '../src/components/AppText';
import { CalibrateLogo } from '../src/components/CalibrateLogo';
import { KeyboardAwareScrollView } from '../src/components/KeyboardAwareScrollView';
import { LoadingState } from '../src/components/LoadingState';
import { Screen, SCREEN_WIDE_LAYOUT_BREAKPOINT } from '../src/components/Screen';
import type { FocusableFormControl } from '../src/components/FormField';
import { getKeyboardAvoidingBehavior } from '../src/utils/keyboard';
import { spacing, useAppTheme } from '../src/theme';
import { OnboardingProgress } from '../src/onboarding/OnboardingProgress';
import { AboutYouStep, ActivityStep, YourPlanStep, OnboardingTargetSummary, type OnboardingControlRefs } from '../src/onboarding/OnboardingSteps';
import { useOnboardingController } from '../src/onboarding/useOnboardingController';
import { ONBOARDING_STEPS } from '../src/onboarding/steps';
import type { OnboardingField } from '../src/onboarding/completionState';
import { clearOnboardingDraft } from '../src/onboarding/draftStorage';

// Keep enough room to read and edit a form group beside a fixed phone footer.
const MIN_FORM_VIEWPORT_HEIGHT = 240;

const CONTROL_ORDER: OnboardingField[] = ['sex', 'dateOfBirth', 'currentWeight', 'height', 'timezone', 'activityLevel', 'goalMode', 'targetWeight', 'dailyChangeAbs'];

export default function OnboardingScreen() {
    const { user, serverUrl, isLoading } = useAuth();
    const accessRoute = restrictedAccountRoute(user);
    useEffect(() => {
        if (user?.onboarding_completed_at) void clearOnboardingDraft(serverUrl, user.id).catch(() => undefined);
    }, [user?.id, user?.onboarding_completed_at, serverUrl]);
    if (isLoading) return <LoadingState label="Checking your session..." />;
    if (!user) return <Redirect href="/(auth)/login" />;
    if (accessRoute) return <Redirect href={accessRoute} />;
    if (user.onboarding_completed_at) return <Redirect href="/today" />;
    return <OnboardingForm key={`${serverUrl}/${user.id}`} user={user} />;
}

function OnboardingForm({ user }: { user: UserClientPayload }) {
    const controller = useOnboardingController(user);
    const { colors } = useAppTheme();
    const { width, fontScale } = useWindowDimensions();
    const desktop = width >= SCREEN_WIDE_LAYOUT_BREAKPOINT;
    const [availableHeight, setAvailableHeight] = useState(0);
    const [actionHeight, setActionHeight] = useState(0);
    const inlineActions = desktop || fontScale >= 1.5
        || (availableHeight > 0 && actionHeight + MIN_FORM_VIEWPORT_HEIGHT > availableHeight);
    const headingRef = useRef<View>(null);
    const controls = useMemo(() => Object.fromEntries(CONTROL_ORDER.map((field) => [
        field, React.createRef<FocusableFormControl>()
    ])) as OnboardingControlRefs, []);
    const currentStep = ONBOARDING_STEPS[controller.activeIndex];
    const handledFocusAttempt = useRef(0);
    useEffect(() => {
        if (controller.isHydrating) return;
        if (Platform.OS === 'web') headingRef.current?.focus();
        else {
            const handle = findNodeHandle(headingRef.current);
            if (handle !== null) AccessibilityInfo.setAccessibilityFocus(handle);
        }
    }, [controller.step, controller.isHydrating]);
    useEffect(() => {
        if (!controller.focusAttempt || controller.isHydrating || handledFocusAttempt.current === controller.focusAttempt) return;
        const firstError = CONTROL_ORDER.find((field) => controller.errors[field]);
        if (!firstError) return;
        // Let the submitting press finish before moving keyboard focus into the form.
        const frame = requestAnimationFrame(() => {
            // Editing field errors must not move focus again after this submission.
            handledFocusAttempt.current = controller.focusAttempt;
            controls[firstError].current?.focus();
            AccessibilityInfo.announceForAccessibility(controller.errors[firstError]!);
        });
        return () => cancelAnimationFrame(frame);
    }, [controller.errors, controller.focusAttempt, controller.step, controller.isHydrating, controls]);

    const busy = controller.completion.isPending;
    const actions = (
        <View onLayout={(event) => setActionHeight(event.nativeEvent.layout.height)} style={[styles.actionBar, { borderTopColor: colors.outlineVariant, backgroundColor: colors.background }]}>
            {controller.step === 'plan' && <OnboardingTargetSummary controller={controller} compact={!desktop} />}
            {controller.actionError && <AppNotice tone="danger"><AppText accessibilityRole="alert">{controller.actionError}</AppText></AppNotice>}
            {controller.step === 'plan' && !controller.isOnline && <AppText variant="muted">Connect to the internet to check your plan and start tracking.</AppText>}
            <View style={[styles.actions, fontScale >= 1.5 && styles.stacked]}>
                {(controller.activeIndex > 0 || controller.returnToPlan) && <AppButton title="Back" variant="ghost"
                    onPress={controller.back} disabled={busy} />}
                <AppButton title={controller.step === 'plan' ? 'Start tracking' : 'Continue'}
                    busy={busy} busyLabel="Saving your plan..."
                    testID={controller.step === 'plan' ? 'onboarding-complete' : 'onboarding-continue'}
                    disabled={controller.isHydrating || (controller.step === 'plan' && (!controller.planVerified || !controller.isOnline))}
                    onPress={controller.next} style={styles.primaryAction} />
            </View>
        </View>
    );

    let stepContent: React.ReactNode;
    if (controller.step === 'about') stepContent = <AboutYouStep controller={controller} controls={controls} />;
    else if (controller.step === 'activity') stepContent = <ActivityStep controller={controller} controls={controls} />;
    else stepContent = <YourPlanStep controller={controller} controls={controls} />;

    return (
        <Screen testID="onboarding-root" contentWidth="form" scroll={false} safeTop style={styles.screen}>
            <KeyboardAvoidingView behavior={getKeyboardAvoidingBehavior(Platform.OS)} style={styles.wizard}
                onLayout={(event) => setAvailableHeight(event.nativeEvent.layout.height)}>
                <KeyboardAwareScrollView key={controller.step} contentContainerStyle={styles.content} revealFocusedInputOnFocus
                    keyboardDismissMode={Platform.OS === 'web' ? 'none' : 'on-drag'}>
                    <View style={styles.brand}>
                        <CalibrateLogo size={28} />
                        <AppText variant="label" style={{ color: colors.primary }}>calibrate</AppText>
                    </View>
                    <OnboardingProgress activeIndex={controller.activeIndex} />
                    <View ref={headingRef} tabIndex={-1} style={styles.heading}>
                        <AppText nativeID="route-focus-title" accessibilityRole="header" aria-level={1} variant="page">{currentStep.title}</AppText>
                        <AppText variant="muted">{currentStep.description}</AppText>
                    </View>
                    {controller.storageError && <AppNotice tone="warning"><AppText>{controller.storageError}</AppText></AppNotice>}
                    {controller.isHydrating ? <LoadingState label="Restoring your setup..." /> : stepContent}
                    {inlineActions && actions}
                </KeyboardAwareScrollView>
                {!inlineActions && actions}
            </KeyboardAvoidingView>
        </Screen>
    );
}

const styles = StyleSheet.create({
    screen: { gap: 0 },
    wizard: { flex: 1, minHeight: 0 },
    content: { gap: spacing.xl, paddingBottom: spacing.lg },
    brand: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    heading: { gap: spacing.sm },
    actionBar: { gap: spacing.md, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: spacing.md },
    actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    stacked: { flexDirection: 'column', alignItems: 'stretch' },
    primaryAction: { flex: 1 }
});
