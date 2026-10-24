/** @file reset password: Consumes the recovery token and validates a replacement password before submitting it. */

import { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Link, useLocalSearchParams } from 'expo-router';
import { AppButton } from '../src/components/AppButton';
import { AppText } from '../src/components/AppText';
import { TextField } from '../src/components/TextField';
import { TrustPageShell, trustPageStyles } from '../src/components/auth/TrustPageShell';
import { consumeOneTimeToken } from '../src/auth/oneTimeToken';
import { useAuth } from '../src/auth/AuthContext';
import { getAccountTrustErrorMessage } from '../src/errors/presentation';
import { useAppTheme } from '../src/theme';

const MIN_PASSWORD_LENGTH = 8;

/** Consumes the recovery token and validates a replacement password before submitting it. */
export default function ResetPasswordRoute() {
    const params = useLocalSearchParams<{ token?: string | string[]; '#'?: string | string[] }>();
    const { api } = useAuth();
    const { colors } = useAppTheme();
    const [token, setToken] = useState<string | null>(null);
    const [password, setPassword] = useState('');
    const [confirmation, setConfirmation] = useState('');
    const [passwordError, setPasswordError] = useState<string | null>(null);
    const [confirmationError, setConfirmationError] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [complete, setComplete] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const tokenCaptureStarted = useRef(false);

    useEffect(() => {
        if (tokenCaptureStarted.current) return;
        tokenCaptureStarted.current = true;
        setToken(consumeOneTimeToken(params.token, undefined, params['#']));
    }, [params]);

    async function confirmReset() {
        if (!token) {
            setError('This reset link is missing or has expired. Request a new one.');
            return;
        }
        if (password.length < MIN_PASSWORD_LENGTH) {
            setPasswordError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
            return;
        }
        if (password !== confirmation) {
            setConfirmationError('Passwords do not match.');
            return;
        }
        setPasswordError(null);
        setConfirmationError(null);
        setError(null);
        setIsSubmitting(true);
        try {
            await api.confirmPasswordReset({ token, new_password: password });
            setToken(null);
            setPassword('');
            setConfirmation('');
            setComplete(true);
        } catch (requestError) {
            setError(getAccountTrustErrorMessage(requestError, 'Unable to reset your password. Try again.'));
        } finally {
            setIsSubmitting(false);
        }
    }

    return (
        <TrustPageShell
            title="Choose a new password"
            description="A successful reset signs out every browser, phone, and watch session for this account."
            footer={(
                <View style={trustPageStyles.links}>
                    <Link href={complete ? '/(auth)/login' : '/forgot-password'} asChild>
                        <Pressable accessibilityRole="link" style={trustPageStyles.linkTarget}>
                            <AppText style={{ color: colors.primary, fontWeight: '600' }}>
                                {complete ? 'Sign in' : 'Request a new link'}
                            </AppText>
                        </Pressable>
                    </Link>
                    <Link href="/support" asChild>
                        <Pressable accessibilityRole="link" style={trustPageStyles.linkTarget}>
                            <AppText style={{ color: colors.primary, fontWeight: '600' }}>Support</AppText>
                        </Pressable>
                    </Link>
                </View>
            )}
        >
            {complete ? (
                <AppText accessibilityRole="alert" accessibilityLiveRegion="polite">
                    Password updated. Sign in again on each device you want to keep using.
                </AppText>
            ) : (
                <>
                    <TextField
                        label="New password"
                        helperText={`At least ${MIN_PASSWORD_LENGTH} characters.`}
                        secureTextEntry
                        autoComplete="new-password"
                        textContentType="newPassword"
                        value={password}
                        errorText={passwordError ?? undefined}
                        focusError={Boolean(passwordError)}
                        onChangeText={(value) => {
                            setPassword(value);
                            if (passwordError) setPasswordError(null);
                        }}
                    />
                    <TextField
                        label="Confirm new password"
                        secureTextEntry
                        autoComplete="new-password"
                        textContentType="newPassword"
                        value={confirmation}
                        errorText={confirmationError ?? undefined}
                        focusError={Boolean(confirmationError)}
                        onChangeText={(value) => {
                            setConfirmation(value);
                            if (confirmationError) setConfirmationError(null);
                        }}
                        onSubmitEditing={() => void confirmReset()}
                    />
                    {!token && (
                        <AppText accessibilityRole="alert" style={{ color: colors.danger }}>
                            This reset link is missing or has expired. Request a new one.
                        </AppText>
                    )}
                    {error && <AppText accessibilityRole="alert" style={{ color: colors.danger }}>{error}</AppText>}
                    <AppButton
                        title="Update password"
                        busy={isSubmitting}
                        busyLabel="Updating..."
                        disabled={!token}
                        onPress={() => void confirmReset()}
                    />
                </>
            )}
        </TrustPageShell>
    );
}
