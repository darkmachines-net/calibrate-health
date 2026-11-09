/** @file Password/native provider registration with explicit legal acceptance on the configured backend. */

import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Link, type Href } from 'expo-router';
import { CALIBRATE_PRODUCT_LINKS } from '@calibrate/shared/product';
import { AppButton } from '../../src/components/AppButton';
import { AppSection } from '../../src/components/AppSection';
import { AppText } from '../../src/components/AppText';
import { AuthBrand } from '../../src/components/auth/AuthBrand';
import { Screen } from '../../src/components/Screen';
import { SectionHeader } from '../../src/components/SectionHeader';
import { TextField } from '../../src/components/TextField';
import { LegalConsentFields } from '../../src/components/legal/LegalConsentFields';
import { useAuth } from '../../src/auth/AuthContext';
import { spacing, useAppTheme } from '../../src/theme';
import { getAuthActionErrorMessage } from '../../src/errors/presentation';
import type { SocialAuthProvider } from '@calibrate/shared/socialAuth';
import { SocialAuthButtons } from '../../src/auth/SocialAuthButtons';
import { socialAuthErrorMessage } from '../../src/auth/socialAuthErrors';
import { requiresHostedLegalAcceptance } from '../../src/auth/accountAccess';
import {
    MAX_AUTH_PASSWORD_BYTES,
    MIN_AUTH_PASSWORD_LENGTH,
    normalizeAuthEmailCredential,
    utf8ByteLength
} from '../../../shared/authCredentials';

/** Presents account creation with explicit legal acceptance on the configured backend. */
export default function RegisterScreen() {
    const { colors } = useAppTheme();
    const { register, signInWithProvider, serverUrl, authError } = useAuth();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [termsAccepted, setTermsAccepted] = useState(false);
    const [privacyAccepted, setPrivacyAccepted] = useState(false);
    const [consentError, setConsentError] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const legalConsentRequired = requiresHostedLegalAcceptance(serverUrl);

    async function handleRegister() {
        if (isSubmitting) return;
        const normalizedEmail = normalizeAuthEmailCredential(email);
        if (!normalizedEmail) {
            setError('Enter a valid email address.');
            return;
        }
        if (password.length < MIN_AUTH_PASSWORD_LENGTH) {
            setError(`Password must be at least ${MIN_AUTH_PASSWORD_LENGTH} characters.`);
            return;
        }
        if (utf8ByteLength(password) > MAX_AUTH_PASSWORD_BYTES) {
            setError(`Password must be at most ${MAX_AUTH_PASSWORD_BYTES} bytes.`);
            return;
        }
        if (password !== confirmPassword) {
            setError('Passwords do not match.');
            return;
        }
        if (legalConsentRequired && (!termsAccepted || !privacyAccepted)) {
            setConsentError('Review and accept both legal documents to create an account.');
            return;
        }

        setIsSubmitting(true);
        setError(null);
        setConsentError(null);
        try {
            await register(normalizedEmail, password, {
                acceptTerms: termsAccepted,
                acceptPrivacy: privacyAccepted
            });
        } catch (err) {
            setError(getAuthActionErrorMessage(err, 'create account'));
        } finally {
            setIsSubmitting(false);
        }
    }

    async function handleProvider(provider: SocialAuthProvider) {
        if (isSubmitting) return;
        if (legalConsentRequired && (!termsAccepted || !privacyAccepted)) {
            setConsentError('Review and accept both legal documents to create an account.');
            return;
        }
        setIsSubmitting(true);
        setError(null);
        setConsentError(null);
        try {
            await signInWithProvider(provider, 'register', { acceptTerms: termsAccepted, acceptPrivacy: privacyAccepted });
        } catch (err) { setError(socialAuthErrorMessage(err)); }
        finally { setIsSubmitting(false); }
    }

    return (
        <Screen contentWidth="form" safeTop style={styles.screen}>
            <AuthBrand description="Track food, weight, and progress against a personalized calorie target." />

            <AppSection>
                <SectionHeader title="Create account" description="Choose how to create your Calibrate account." />
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
                    autoComplete="new-password"
                    autoCorrect={false}
                    textContentType="newPassword"
                    returnKeyType="next"
                    secureTextEntry
                    value={password}
                    onChangeText={setPassword}
                />
                <TextField
                    label="Confirm password"
                    autoCapitalize="none"
                    autoComplete="new-password"
                    autoCorrect={false}
                    textContentType="newPassword"
                    returnKeyType="go"
                    secureTextEntry
                    value={confirmPassword}
                    onChangeText={setConfirmPassword}
                    onSubmitEditing={() => void handleRegister()}
                />
                {legalConsentRequired && <LegalConsentFields
                    termsAccepted={termsAccepted}
                    privacyAccepted={privacyAccepted}
                    onTermsAcceptedChange={(checked) => {
                        setTermsAccepted(checked);
                        if (consentError) setConsentError(null);
                    }}
                    onPrivacyAcceptedChange={(checked) => {
                        setPrivacyAccepted(checked);
                        if (consentError) setConsentError(null);
                    }}
                    disabled={isSubmitting}
                    error={consentError}
                />}
                {(error || authError) && <AppText accessibilityRole="alert" style={{ color: colors.danger }}>{error ?? authError}</AppText>}
                <AppButton title={isSubmitting ? 'Creating...' : 'Create account'} disabled={isSubmitting} onPress={() => void handleRegister()} />
                <SocialAuthButtons serverUrl={serverUrl} disabled={isSubmitting} onPress={provider => void handleProvider(provider)} />
            </AppSection>

            <View style={styles.footerLinks}>
                <Link
                    href="/(auth)/login"
                    asChild
                >
                    <Pressable accessibilityRole="link" style={styles.linkTarget}>
                        <AppText style={[styles.link, { color: colors.primary }]}>Back to sign in</AppText>
                    </Pressable>
                </Link>
                <Link href={CALIBRATE_PRODUCT_LINKS.support as Href} asChild>
                    <Pressable accessibilityRole="link" style={styles.linkTarget}>
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
    linkTarget: {
        minHeight: 48,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.sm
    },
    footerLinks: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: spacing.md
    },
    link: {
        fontWeight: '600',
        textAlign: 'center'
    }
});
