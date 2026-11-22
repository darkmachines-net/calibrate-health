/** @file Show native Google sign-in when the configured backend and this device support it. */
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { CalibrateApiClient } from '@calibrate/api-client';
import { SOCIAL_AUTH_PROVIDERS } from '@calibrate/shared/socialAuth';
import { normalizeServerUrl } from '../config/server';
import { AppText } from '../components/AppText';
import { interaction, spacing } from '../theme';
import { supportsNativeGoogleSignIn } from './nativeSocialAuth';
import type { SocialAuthButtonsProps } from './SocialAuthButtons.types';

// Defer provider discovery until the auth screen mounts.
const SERVER_DISCOVERY_DELAY_MS = 300;

/** Check Google availability for the current backend, ignoring results from a previous backend. */
export function SocialAuthButtons({ serverUrl, disabled, onPress, label, children }: SocialAuthButtonsProps) {
    const [availableServer, setAvailableServer] = useState<string | null>(null);
    useEffect(() => {
        const normalized = normalizeServerUrl(serverUrl);
        if (!normalized || !supportsNativeGoogleSignIn()) return;
        let active = true;
        const timer = setTimeout(() => {
            void (async () => {
                try {
                    const { providers } = await new CalibrateApiClient({ baseUrl: normalized }).getMobileSocialProviders();
                    if (active) setAvailableServer(providers.includes(SOCIAL_AUTH_PROVIDERS.GOOGLE) ? serverUrl : null);
                } catch {
                    if (active) setAvailableServer(null);
                }
            })();
        }, SERVER_DISCOVERY_DELAY_MS);
        return () => { active = false; clearTimeout(timer); };
    }, [serverUrl]);
    if (availableServer !== serverUrl) return null;
    const { GoogleSigninButton }: typeof import('@react-native-google-signin/google-signin') = require('@react-native-google-signin/google-signin');
    return <View style={styles.group}>
        {label && <AppText variant="muted">{label}</AppText>}
        <GoogleSigninButton
            style={styles.button}
            size={GoogleSigninButton.Size.Wide}
            color={GoogleSigninButton.Color.Light}
            disabled={disabled}
            onPress={() => onPress(SOCIAL_AUTH_PROVIDERS.GOOGLE)}
        />
        {children}
    </View>;
}

const styles = StyleSheet.create({
    group: { gap: spacing.sm },
    button: { width: '100%', height: interaction.minimumTouchTarget }
});
