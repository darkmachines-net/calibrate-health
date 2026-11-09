/** @file Show the confirmation step for a verified provider identity without a Calibrate account. */
import { useCallback, useRef, useState } from 'react';
import { BackHandler } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { SOCIAL_AUTH_PROVIDERS, type SocialAuthProvider } from '@calibrate/shared/socialAuth';
import type { PendingProviderRegistration } from '../../auth/AuthContext';
import { socialAuthErrorMessage } from '../../auth/socialAuthErrors';
import { AppButton } from '../AppButton';
import { AppSection } from '../AppSection';
import { LegalConsentFields } from '../legal/LegalConsentFields';
import { Screen } from '../Screen';
import { SectionHeader } from '../SectionHeader';

type Props = {
    provider: SocialAuthProvider;
    registration: PendingProviderRegistration;
    onCancel: () => void;
    onFailure: (message: string) => void;
};

/** Collect hosted consent before completing the same verified provider attempt, with a cancellable back action. */
export function ProviderRegistration({ provider, registration, onCancel, onFailure }: Props) {
    const [termsAccepted, setTermsAccepted] = useState(false);
    const [privacyAccepted, setPrivacyAccepted] = useState(false);
    const [consentError, setConsentError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const submitting = useRef(false);
    const providerName = provider === SOCIAL_AUTH_PROVIDERS.GOOGLE ? 'Google' : 'Apple';
    const description = registration.requiresLegalAcceptance
        ? `Review and accept the terms to create your Calibrate account with ${providerName}.`
        : `Create a Calibrate account on this server with ${providerName}.`;

    useFocusEffect(useCallback(() => {
        const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
            if (!submitting.current) onCancel();
            return true;
        });
        return () => subscription.remove();
    }, [onCancel]));

    async function complete() {
        if (submitting.current) return;
        if (registration.requiresLegalAcceptance && (!termsAccepted || !privacyAccepted)) {
            setConsentError('Review and accept both legal documents to create an account.');
            return;
        }
        submitting.current = true;
        setBusy(true);
        try {
            if (!(await registration.complete({ acceptTerms: termsAccepted, acceptPrivacy: privacyAccepted }))) {
                onFailure('This sign-in attempt expired. Sign in again to continue.');
            }
        } catch (error) {
            onFailure(socialAuthErrorMessage(error));
        } finally {
            submitting.current = false;
            setBusy(false);
        }
    }

    return (
        <Screen safeTop contentWidth="form">
            <AppSection>
                <AppButton title="Back to welcome" variant="ghost" disabled={busy} onPress={onCancel} />
                <SectionHeader headingLevel={1} title="Finish creating your account" description={description} />
                {registration.requiresLegalAcceptance && (
                    <LegalConsentFields
                        termsAccepted={termsAccepted}
                        privacyAccepted={privacyAccepted}
                        onTermsAcceptedChange={(accepted) => { setTermsAccepted(accepted); setConsentError(null); }}
                        onPrivacyAcceptedChange={(accepted) => { setPrivacyAccepted(accepted); setConsentError(null); }}
                        error={consentError}
                        disabled={busy}
                    />
                )}
                <AppButton title="Create account" busy={busy} busyLabel="Creating account..." onPress={() => void complete()} />
            </AppSection>
        </Screen>
    );
}
