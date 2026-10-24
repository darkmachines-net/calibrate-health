/** @file legal update: Collects explicit acceptance of updated legal documents before restoring full account access. */

import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Link, Redirect, router } from 'expo-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AppButton } from '../src/components/AppButton';
import { AppText } from '../src/components/AppText';
import { LegalConsentFields } from '../src/components/legal/LegalConsentFields';
import { LoadingState } from '../src/components/LoadingState';
import { TrustPageShell, trustPageStyles } from '../src/components/auth/TrustPageShell';
import { useAuth } from '../src/auth/AuthContext';
import { getAccountTrustErrorMessage } from '../src/errors/presentation';
import { useAppTheme } from '../src/theme';

/** Collects explicit acceptance of updated legal documents before restoring full account access. */
export default function LegalUpdateRoute() {
    const { api, user, isLoading, logout, updateCurrentUser } = useAuth();
    const { colors } = useAppTheme();
    const [termsAccepted, setTermsAccepted] = useState(false);
    const [privacyAccepted, setPrivacyAccepted] = useState(false);
    const [consentError, setConsentError] = useState<string | null>(null);
    const [complete, setComplete] = useState(false);
    const legalStatus = useQuery({
        queryKey: ['account-legal-status'],
        queryFn: () => api.getLegalStatus(),
        enabled: Boolean(user)
    });
    const acceptLegal = useMutation({
        mutationFn: async () => {
            if (!termsAccepted || !privacyAccepted) {
                setConsentError('Accept both current documents to continue.');
                return null;
            }
            const required = legalStatus.data?.required;
            if (!required) throw new Error('Current legal versions are unavailable.');
            return api.acceptLegalDocuments({
                terms_version: required.terms_version,
                privacy_version: required.privacy_version,
                accept_terms: true,
                accept_privacy: true
            });
        },
        onSuccess: (result) => {
            if (!result || !user) return;
            updateCurrentUser({ ...user, account_access: result.account_access });
            setComplete(true);
        }
    });

    if (isLoading) return <LoadingState label="Checking account access..." />;
    if (!user) return <Redirect href="/(auth)/login" />;

    const requestError = legalStatus.error ?? acceptLegal.error;
    const errorMessage = requestError
        ? getAccountTrustErrorMessage(requestError, 'Unable to update your legal acceptance. Try again.')
        : null;

    return (
        <TrustPageShell
            title="Review legal updates"
            description="Calibrate needs your current acceptance before health and tracking features resume."
            footer={(
                <View style={trustPageStyles.links}>
                    <Link href="/support" asChild>
                        <Pressable accessibilityRole="link" style={trustPageStyles.linkTarget}>
                            <AppText style={{ color: colors.primary, fontWeight: '600' }}>Support</AppText>
                        </Pressable>
                    </Link>
                    <Link href="/account-deletion" asChild>
                        <Pressable accessibilityRole="link" style={trustPageStyles.linkTarget}>
                            <AppText style={{ color: colors.primary, fontWeight: '600' }}>Account data and deletion</AppText>
                        </Pressable>
                    </Link>
                    <Pressable accessibilityRole="button" style={trustPageStyles.linkTarget} onPress={() => void logout()}>
                        <AppText style={{ color: colors.primary, fontWeight: '600' }}>Sign out</AppText>
                    </Pressable>
                </View>
            )}
        >
            {legalStatus.isPending ? (
                <LoadingState label="Loading legal status..." />
            ) : complete ? (
                <>
                    <AppText accessibilityRole="alert" accessibilityLiveRegion="polite">
                        Legal acceptance updated. Tracking features are available again.
                    </AppText>
                    <AppButton title="Continue to Calibrate" onPress={() => router.replace('/today')} />
                </>
            ) : (
                <>
                    <AppText>
                        Review the current Terms and Privacy policy. Your existing data remains available for export or deletion if you choose not to accept.
                    </AppText>
                    <LegalConsentFields
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
                        disabled={acceptLegal.isPending}
                        error={consentError}
                    />
                    {errorMessage && <AppText accessibilityRole="alert" style={{ color: colors.danger }}>{errorMessage}</AppText>}
                    <AppButton
                        title="Accept and continue"
                        busy={acceptLegal.isPending}
                        busyLabel="Saving..."
                        disabled={!legalStatus.data}
                        onPress={() => acceptLegal.mutate()}
                    />
                </>
            )}
        </TrustPageShell>
    );
}
