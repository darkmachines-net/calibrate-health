/** @file verify email: Confirms a verification token or requests a new message while preserving restricted-account access. */

import { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Link, router, useLocalSearchParams } from 'expo-router';
import { AppButton } from '../src/components/AppButton';
import { AppText } from '../src/components/AppText';
import { TextField } from '../src/components/TextField';
import { TrustPageShell, trustPageStyles } from '../src/components/auth/TrustPageShell';
import { useAuth } from '../src/auth/AuthContext';
import { ACCOUNT_ACCESS_STATES } from '../src/auth/accountAccess';
import { consumeOneTimeToken } from '../src/auth/oneTimeToken';
import { getAccountTrustErrorMessage } from '../src/errors/presentation';
import { useAppTheme } from '../src/theme';

const GENERIC_VERIFICATION_MESSAGE = 'If verification is available for that address, a new email will arrive shortly.';

/** Confirms a verification token or requests a new message while preserving restricted-account access. */
export default function VerifyEmailRoute() {
    const params = useLocalSearchParams<{ token?: string | string[]; '#'?: string | string[] }>();
    const { api, user, updateCurrentUser, logout } = useAuth();
    const { colors } = useAppTheme();
    const [token, setToken] = useState<string | null>(null);
    const [email, setEmail] = useState(user?.email ?? '');
    const [emailError, setEmailError] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const [isConfirming, setIsConfirming] = useState(false);
    const [isResending, setIsResending] = useState(false);
    const tokenCaptureStarted = useRef(false);
    const confirmationStarted = useRef(false);

    useEffect(() => {
        if (tokenCaptureStarted.current) return;
        tokenCaptureStarted.current = true;
        const capturedToken = consumeOneTimeToken(params.token, undefined, params['#']);
        if (!capturedToken) return;
        setToken(capturedToken);
        setIsConfirming(true);
    }, [params]);

    useEffect(() => {
        if (!token || confirmationStarted.current) return;
        confirmationStarted.current = true;
        let active = true;
        void api.confirmEmailVerification({ token }).then(async () => {
            if (!active) return;
            setToken(null);
            setMessage('Email verified.');
            if (user) {
                const refreshed = await api.getMe();
                if (active) updateCurrentUser(refreshed.user);
            }
        }).catch((requestError: unknown) => {
            if (active) setError(getAccountTrustErrorMessage(requestError, 'Unable to verify this email. Try again.'));
        }).finally(() => {
            if (active) setIsConfirming(false);
        });
        return () => { active = false; };
    }, [api, token, updateCurrentUser, user]);

    async function resend() {
        if (!email.trim()) {
            setEmailError('Enter your email address.');
            return;
        }
        setEmailError(null);
        setError(null);
        setMessage(null);
        setIsResending(true);
        try {
            await api.resendEmailVerification({ email: email.trim() });
            setMessage(GENERIC_VERIFICATION_MESSAGE);
        } catch (requestError) {
            setError(getAccountTrustErrorMessage(requestError, 'Unable to send a verification email. Try again.'));
        } finally {
            setIsResending(false);
        }
    }

    const nextAccessState = user?.account_access?.state;
    const canContinue = message === 'Email verified.' && nextAccessState !== ACCOUNT_ACCESS_STATES.EMAIL_VERIFICATION_REQUIRED;
    let continueTitle = 'Continue to Calibrate';
    let continueRoute: '/(auth)/login' | '/legal-update' | '/today' = '/today';
    if (!user) {
        continueTitle = 'Sign in';
        continueRoute = '/(auth)/login';
    } else if (nextAccessState === ACCOUNT_ACCESS_STATES.LEGAL_ACCEPTANCE_REQUIRED) {
        continueTitle = 'Review legal updates';
        continueRoute = '/legal-update';
    }

    return (
        <TrustPageShell
            title="Verify your email"
            description="Verification links expire after 24 hours and can be used once."
            footer={(
                <View style={trustPageStyles.links}>
                    {!user && (
                        <Link href="/(auth)/login" asChild>
                            <Pressable accessibilityRole="link" style={trustPageStyles.linkTarget}>
                                <AppText style={{ color: colors.primary, fontWeight: '600' }}>Back to sign in</AppText>
                            </Pressable>
                        </Link>
                    )}
                    {user && (
                        <Link href="/account-deletion" asChild>
                            <Pressable accessibilityRole="link" style={trustPageStyles.linkTarget}>
                                <AppText style={{ color: colors.primary, fontWeight: '600' }}>Account data and deletion</AppText>
                            </Pressable>
                        </Link>
                    )}
                    <Link href="/support" asChild>
                        <Pressable accessibilityRole="link" style={trustPageStyles.linkTarget}>
                            <AppText style={{ color: colors.primary, fontWeight: '600' }}>Support</AppText>
                        </Pressable>
                    </Link>
                    {user && (
                        <Pressable accessibilityRole="button" style={trustPageStyles.linkTarget} onPress={() => void logout()}>
                            <AppText style={{ color: colors.primary, fontWeight: '600' }}>Sign out</AppText>
                        </Pressable>
                    )}
                </View>
            )}
        >
            {isConfirming ? (
                <AppText accessibilityRole="alert" accessibilityLiveRegion="polite">Verifying your email...</AppText>
            ) : (
                <>
                    {message && <AppText accessibilityRole="alert" accessibilityLiveRegion="polite">{message}</AppText>}
                    {error && <AppText accessibilityRole="alert" style={{ color: colors.danger }}>{error}</AppText>}
                    {canContinue && (
                        <AppButton
                            title={continueTitle}
                            onPress={() => router.replace(continueRoute)}
                        />
                    )}
                    {!canContinue && (
                        <>
                            <TextField
                                label="Email"
                                autoCapitalize="none"
                                autoComplete="email"
                                autoCorrect={false}
                                keyboardType="email-address"
                                editable={!user && !isResending}
                                value={email}
                                errorText={emailError ?? undefined}
                                focusError={Boolean(emailError)}
                                onChangeText={(value) => {
                                    setEmail(value);
                                    if (emailError) setEmailError(null);
                                }}
                            />
                            <AppButton
                                title="Send verification email"
                                variant="secondary"
                                busy={isResending}
                                busyLabel="Sending..."
                                onPress={() => void resend()}
                            />
                        </>
                    )}
                </>
            )}
        </TrustPageShell>
    );
}
