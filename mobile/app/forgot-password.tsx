/** @file forgot password: Requests password recovery with field validation and privacy-preserving result messaging. */

import { useState } from 'react';
import { Pressable } from 'react-native';
import { Link } from 'expo-router';
import { AppButton } from '../src/components/AppButton';
import { AppText } from '../src/components/AppText';
import { TextField } from '../src/components/TextField';
import { TrustPageShell, trustPageStyles } from '../src/components/auth/TrustPageShell';
import { useAuth } from '../src/auth/AuthContext';
import { getAccountTrustErrorMessage } from '../src/errors/presentation';
import { useAppTheme } from '../src/theme';

const GENERIC_RESET_MESSAGE = 'If an eligible account matches that email, reset instructions will arrive shortly.';

/** Requests password recovery with field validation and privacy-preserving result messaging. */
export default function ForgotPasswordRoute() {
    const { api } = useAuth();
    const { colors } = useAppTheme();
    const [email, setEmail] = useState('');
    const [emailError, setEmailError] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);

    async function requestReset() {
        if (!email.trim()) {
            setEmailError('Enter your email address.');
            return;
        }
        setEmailError(null);
        setError(null);
        setMessage(null);
        setIsSubmitting(true);
        try {
            await api.requestPasswordReset({ email: email.trim() });
            setMessage(GENERIC_RESET_MESSAGE);
        } catch (requestError) {
            setError(getAccountTrustErrorMessage(requestError, 'Unable to request a password reset. Try again.'));
        } finally {
            setIsSubmitting(false);
        }
    }

    return (
        <TrustPageShell
            title="Reset password"
            description="Enter your account email. For privacy, the response is the same whether or not an account exists."
            footer={(
                <Link href="/(auth)/login" asChild>
                    <Pressable accessibilityRole="link" style={trustPageStyles.linkTarget}>
                        <AppText style={{ color: colors.primary, fontWeight: '600' }}>Back to sign in</AppText>
                    </Pressable>
                </Link>
            )}
        >
            <TextField
                label="Email"
                autoCapitalize="none"
                autoComplete="email"
                autoCorrect={false}
                keyboardType="email-address"
                textContentType="emailAddress"
                value={email}
                errorText={emailError ?? undefined}
                focusError={Boolean(emailError)}
                onChangeText={(value) => {
                    setEmail(value);
                    if (emailError) setEmailError(null);
                }}
                onSubmitEditing={() => void requestReset()}
            />
            {message && <AppText accessibilityRole="alert" accessibilityLiveRegion="polite">{message}</AppText>}
            {error && <AppText accessibilityRole="alert" style={{ color: colors.danger }}>{error}</AppText>}
            <AppButton
                title="Send reset instructions"
                busy={isSubmitting}
                busyLabel="Sending..."
                onPress={() => void requestReset()}
            />
        </TrustPageShell>
    );
}
