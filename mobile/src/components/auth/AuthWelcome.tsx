/** @file Shared public welcome with native provider sign-in and separate email routes. */
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { Link, type Href } from 'expo-router';
import { CALIBRATE_PRODUCT_LINKS } from '@calibrate/shared/product';
import type { SocialAuthProvider } from '@calibrate/shared/socialAuth';
import { useAuth, type PendingProviderRegistration } from '../../auth/AuthContext';
import { authEntryHref, type AuthEntryParams } from '../../auth/authEntryHref';
import { SocialAuthButtons } from '../../auth/SocialAuthButtons';
import { socialAuthErrorMessage } from '../../auth/socialAuthErrors';
import { TABLET_LAYOUT_BREAKPOINT } from '../../layout/adaptiveLayout';
import { interaction, spacing, useAppTheme } from '../../theme';
import { AppButton } from '../AppButton';
import { AppText } from '../AppText';
import { CalibrateLogo } from '../CalibrateLogo';
import { Screen } from '../Screen';
import { ProviderRegistration } from './ProviderRegistration';
import { WelcomeCalories } from './WelcomeCalories';

// Keep the gauge proportional to the compact wordmark.
const BRAND_MARK_SIZE = 28;
const TRUST_LINKS = [
    { href: CALIBRATE_PRODUCT_LINKS.privacy, label: 'Privacy policy' },
    { href: CALIBRATE_PRODUCT_LINKS.terms, label: 'Terms of service' },
    { href: CALIBRATE_PRODUCT_LINKS.support, label: 'Support' }
] as const;

type Props = {
    browser?: boolean;
    params?: AuthEntryParams;
};

/** Present one entry point per available provider and keep email actions reachable on every server. */
export function AuthWelcome({ browser = false, params }: Props) {
    const { colors } = useAppTheme();
    const { width } = useWindowDimensions();
    const { serverUrl, authError, signInWithProvider } = useAuth();
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [pending, setPending] = useState<{ provider: SocialAuthProvider; registration: PendingProviderRegistration } | null>(null);
    const attempt = useRef<AbortController | null>(null);
    const wide = browser && width >= TABLET_LAYOUT_BREAKPOINT;

    useEffect(() => () => attempt.current?.abort(), []);

    async function startProvider(provider: SocialAuthProvider) {
        if (attempt.current) return;
        const controller = new AbortController();
        attempt.current = controller;
        setBusy(true);
        setError(null);
        let awaitingRegistration = false;
        try {
            const registration = await signInWithProvider(provider, controller.signal);
            if (registration && !controller.signal.aborted) {
                awaitingRegistration = true;
                setPending({ provider, registration });
            }
        } catch (failure) {
            if (!controller.signal.aborted) setError(socialAuthErrorMessage(failure));
        } finally {
            if (!awaitingRegistration) attempt.current = null;
            if (!controller.signal.aborted) setBusy(false);
        }
    }

    function cancelRegistration() {
        pending?.registration.cancel();
        attempt.current?.abort();
        attempt.current = null;
        setPending(null);
    }

    if (pending) {
        return <ProviderRegistration
            {...pending}
            onCancel={cancelRegistration}
            onFailure={(message) => { cancelRegistration(); setError(message); }}
        />;
    }

    return (
        <Screen safeTop contentWidth={wide ? 'wide' : 'form'} style={styles.screen} testID={browser ? 'hosted-landing' : 'auth-welcome'}>
            <View style={styles.brand}>
                <CalibrateLogo size={BRAND_MARK_SIZE} />
                <AppText variant="section">calibrate</AppText>
            </View>
            <View style={[styles.body, wide && styles.bodyWide]} testID={browser ? 'hosted-landing-primary' : undefined}>
                <View style={[styles.hero, wide && styles.heroWide]}>
                    <AppText variant="page" nativeID="route-focus-title" accessibilityRole="header" aria-level={1}>
                        See your progress.
                    </AppText>
                    <AppText variant="muted">Log meals and weight. See how each day adds up toward your goal.</AppText>
                    <WelcomeCalories />
                    {browser && <AppText variant="caption" testID="hosted-install-copy">
                        Use Calibrate in your browser or install it from a supported browser.
                    </AppText>}
                </View>
                <View style={[styles.actions, wide && styles.actionsWide]} testID={browser ? 'hosted-landing-actions' : undefined}>
                    {!browser && <SocialAuthButtons serverUrl={serverUrl} disabled={busy} onPress={(provider) => void startProvider(provider)}>
                        <View style={styles.divider}>
                            <View style={[styles.rule, { backgroundColor: colors.outlineVariant }]} />
                            <AppText variant="caption">or use email</AppText>
                            <View style={[styles.rule, { backgroundColor: colors.outlineVariant }]} />
                        </View>
                    </SocialAuthButtons>}
                    {busy && <AppText accessibilityLiveRegion="polite" variant="muted">Signing in...</AppText>}
                    {(error || authError) && <AppText accessibilityRole="alert" style={{ color: colors.danger }}>{error ?? authError}</AppText>}
                    <Link href={authEntryHref('register', params)} asChild>
                        <AppButton title="Create Calibrate account" accessibilityRole="link" disabled={busy} />
                    </Link>
                    <Link href={authEntryHref('email', params)} push asChild>
                        <AppButton title="Sign in with email" variant="secondary" accessibilityRole="link" disabled={busy} />
                    </Link>
                </View>
            </View>
            <View style={styles.footer} testID={browser ? 'hosted-landing-trust' : undefined}>
                {browser && <AppText variant="caption" style={styles.trustCopy}>
                    Your account stays under your control. Review signed-in devices, export your data, or delete your account in Settings.
                </AppText>}
                <View style={styles.links} testID={browser ? 'hosted-trust-links' : undefined}>
                    {TRUST_LINKS.map(({ href, label }) => (
                        <Link key={href} href={href as Href} style={[styles.footerLink, { color: colors.primary }]}>
                            {label}
                        </Link>
                    ))}
                    {browser && <Link href="/account-deletion" style={[styles.footerLink, { color: colors.primary }]}>
                        Account deletion
                    </Link>}
                </View>
            </View>
        </Screen>
    );
}

const styles = StyleSheet.create({
    screen: { flexGrow: 1 },
    brand: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    body: { flexGrow: 1, justifyContent: 'space-between', gap: spacing.xl },
    bodyWide: { flexDirection: 'row', alignItems: 'center', gap: spacing.xxl },
    hero: { gap: spacing.md },
    heroWide: { flex: 1.15, minWidth: 0 },
    actions: { gap: spacing.sm },
    actionsWide: { flex: 1, minWidth: 0 },
    divider: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    rule: { height: StyleSheet.hairlineWidth, flex: 1 },
    footer: { gap: spacing.xs },
    trustCopy: { textAlign: 'center' },
    links: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', columnGap: spacing.lg },
    footerLink: {
        minHeight: interaction.minimumTouchTarget,
        paddingVertical: spacing.md,
        textAlign: 'center',
        fontWeight: '600'
    }
});
