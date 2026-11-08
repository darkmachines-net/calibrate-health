/** @file Password/native provider sign-in on the configured backend with account-deletion cleanup guidance. */

import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Link, type Href } from 'expo-router';
import { CALIBRATE_PRODUCT_LINKS } from '@calibrate/shared/product';
import { AppButton } from '../../src/components/AppButton';
import { AppSection } from '../../src/components/AppSection';
import { AppNotice } from '../../src/components/AppNotice';
import { AppText } from '../../src/components/AppText';
import { AuthBrand } from '../../src/components/auth/AuthBrand';
import { Screen } from '../../src/components/Screen';
import { SectionHeader } from '../../src/components/SectionHeader';
import { TextField } from '../../src/components/TextField';
import { useAuth } from '../../src/auth/AuthContext';
import { accountDeletionCleanupGuidance } from '../../src/account/accountDeletionNotice';
import { spacing, useAppTheme } from '../../src/theme';
import { getAuthActionErrorMessage } from '../../src/errors/presentation';
import type { SocialAuthProvider } from '@calibrate/shared/socialAuth';
import { SocialAuthButtons } from '../../src/auth/SocialAuthButtons';
import { socialAuthErrorMessage } from '../../src/auth/socialAuthErrors';

/** Presents sign-in and blocks authentication until pending account-deletion cleanup is acknowledged. */
export default function LoginScreen() {
    const { colors } = useAppTheme();
    const {
        login, signInWithProvider, serverUrl, authError,
        accountDeletionCleanupNotice, acknowledgeAccountDeletionCleanupNotice
    } = useAuth();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function handleLogin() {
        if (accountDeletionCleanupNotice || isSubmitting) return;
        setIsSubmitting(true);
        setError(null);
        try {
            await login(email, password);
        } catch (err) {
            setError(getAuthActionErrorMessage(err, 'sign in'));
        } finally {
            setIsSubmitting(false);
        }
    }

    async function handleProvider(provider: SocialAuthProvider) {
        if (accountDeletionCleanupNotice || isSubmitting) return;
        setIsSubmitting(true);
        setError(null);
        try { await signInWithProvider(provider, 'login'); }
        catch (err) { setError(socialAuthErrorMessage(err)); }
        finally { setIsSubmitting(false); }
    }

    return (
        <Screen contentWidth="form" safeTop style={styles.screen}>
            <AuthBrand description="Track food, weight, and progress against a personalized calorie target." />

            {accountDeletionCleanupNotice && (
                <AppNotice tone="warning" accessibilityLiveRegion="polite" style={[styles.cleanupNotice, { borderColor: colors.warning }]}>
                    <SectionHeader
                        title="Account deleted - device cleanup needed"
                        description={accountDeletionCleanupGuidance(accountDeletionCleanupNotice)}
                    />
                    <AppButton
                        title="I completed these steps"
                        variant="secondary"
                        onPress={() => void acknowledgeAccountDeletionCleanupNotice()}
                    />
                </AppNotice>
            )}

            <AppSection>
                <SectionHeader title="Sign in" description="Use your Calibrate account." />
                <TextField
                    label="Email"
                    autoCapitalize="none"
                    autoComplete="email"
                    autoCorrect={false}
                    textContentType="emailAddress"
                    keyboardType="email-address"
                    value={email}
                    onChangeText={setEmail}
                />
                <TextField
                    label="Password"
                    autoCapitalize="none"
                    autoComplete="current-password"
                    autoCorrect={false}
                    textContentType="password"
                    returnKeyType="go"
                    secureTextEntry
                    value={password}
                    onChangeText={setPassword}
                    onSubmitEditing={() => void handleLogin()}
                />
                <Link href="/forgot-password" asChild>
                    <Pressable accessibilityRole="link" style={styles.inlineLinkTarget}>
                        <AppText style={[styles.link, { color: colors.primary }]}>Forgot password?</AppText>
                    </Pressable>
                </Link>
                {(error || authError) && <AppText accessibilityRole="alert" style={{ color: colors.danger }}>{error ?? authError}</AppText>}
                <AppButton
                    title={isSubmitting ? 'Signing in...' : 'Sign in'}
                    disabled={isSubmitting || Boolean(accountDeletionCleanupNotice)}
                    onPress={() => void handleLogin()}
                />
                <SocialAuthButtons serverUrl={serverUrl} disabled={isSubmitting || Boolean(accountDeletionCleanupNotice)} onPress={provider => void handleProvider(provider)} />
            </AppSection>

            {!accountDeletionCleanupNotice && (
                <Link
                    href="/(auth)/register"
                    asChild
                >
                    <Pressable accessibilityRole="link" style={styles.linkTarget}>
                        <AppText style={[styles.link, { color: colors.primary }]}>Create an account</AppText>
                    </Pressable>
                </Link>
            )}

            <View style={styles.trustLinks}>
                <Link href={CALIBRATE_PRODUCT_LINKS.privacy as Href} asChild>
                    <Pressable accessibilityRole="link" style={styles.trustLinkTarget}>
                        <AppText style={[styles.link, { color: colors.primary }]}>Privacy policy</AppText>
                    </Pressable>
                </Link>
                <Link href={CALIBRATE_PRODUCT_LINKS.terms as Href} asChild>
                    <Pressable accessibilityRole="link" style={styles.trustLinkTarget}>
                        <AppText style={[styles.link, { color: colors.primary }]}>Terms of service</AppText>
                    </Pressable>
                </Link>
                <Link href={CALIBRATE_PRODUCT_LINKS.support as Href} asChild>
                    <Pressable accessibilityRole="link" style={styles.trustLinkTarget}>
                        <AppText style={[styles.link, { color: colors.primary }]}>Support</AppText>
                    </Pressable>
                </Link>
            </View>
        </Screen>
    );
}

const styles = StyleSheet.create({
    screen: {
        justifyContent: 'center',
        flexGrow: 1,
        width: '100%',
        alignSelf: 'center'
    },
    cleanupNotice: {
        borderWidth: StyleSheet.hairlineWidth
    },
    linkTarget: {
        minHeight: 48,
        alignItems: 'center',
        justifyContent: 'center'
    },
    inlineLinkTarget: {
        minHeight: 48,
        alignItems: 'flex-start',
        justifyContent: 'center'
    },
    trustLinks: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'center'
    },
    trustLinkTarget: {
        minHeight: 48,
        justifyContent: 'center',
        paddingHorizontal: spacing.sm
    },
    link: {
        fontWeight: '600',
        textAlign: 'center'
    }
});
