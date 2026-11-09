/** @file Show official native provider buttons only when both the configured backend and this device support them. */
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { CalibrateApiClient } from '@calibrate/api-client';
import { SOCIAL_AUTH_PROVIDERS, type SocialAuthProvider } from '@calibrate/shared/socialAuth';
import { normalizeServerUrl } from '../config/server';
import { AppText } from '../components/AppText';
import { interaction, radius, spacing, useAppTheme } from '../theme';
import { nativeSocialProviders } from './nativeSocialAuth';
import type { SocialAuthButtonsProps } from './SocialAuthButtons.types';

// Defer provider discovery until the auth screen mounts.
const SERVER_DISCOVERY_DELAY_MS = 300;

/** Refresh public provider availability on server changes; stale responses cannot re-enable another server's buttons. */
export function SocialAuthButtons({ serverUrl, disabled, onPress, label, children }: SocialAuthButtonsProps) {
    const { dark } = useAppTheme();
    const [available, setAvailable] = useState<{ serverUrl: string; providers: SocialAuthProvider[] } | null>(null);
    useEffect(() => {
        let active = true;
        const timer = setTimeout(() => {
            void (async () => {
                try {
                    const normalized = normalizeServerUrl(serverUrl);
                    if (!normalized) { if (active) setAvailable(null); return; }
                    const [remote, local] = await Promise.all([
                        new CalibrateApiClient({ baseUrl: normalized }).getMobileSocialProviders(), nativeSocialProviders()
                    ]);
                    if (active) setAvailable({ serverUrl, providers: local.filter(provider => remote.providers.includes(provider)) });
                } catch {
                    if (active) setAvailable(null);
                }
            })();
        }, SERVER_DISCOVERY_DELAY_MS);
        return () => { active = false; clearTimeout(timer); };
    }, [serverUrl]);
    const providers = available?.serverUrl === serverUrl ? available.providers : [];
    if (!providers.length) return null;
    const { GoogleSigninButton }: typeof import('@react-native-google-signin/google-signin') = require('@react-native-google-signin/google-signin');
    const AppleAuthentication: typeof import('expo-apple-authentication') = require('expo-apple-authentication');
    return <View style={styles.group}>
        {label && <AppText variant="muted">{label}</AppText>}
        {providers.includes(SOCIAL_AUTH_PROVIDERS.GOOGLE) && <GoogleSigninButton
            style={styles.button}
            size={GoogleSigninButton.Size.Wide}
            color={GoogleSigninButton.Color.Light}
            disabled={disabled}
            onPress={() => onPress(SOCIAL_AUTH_PROVIDERS.GOOGLE)}
        />}
        {providers.includes(SOCIAL_AUTH_PROVIDERS.APPLE) && <View pointerEvents={disabled ? 'none' : 'auto'} accessibilityElementsHidden={disabled}>
            <AppleAuthentication.AppleAuthenticationButton
                style={styles.button}
                buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
                buttonStyle={dark
                    ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE
                    : AppleAuthentication.AppleAuthenticationButtonStyle.WHITE_OUTLINE}
                cornerRadius={radius.sm}
                onPress={() => { if (!disabled) onPress(SOCIAL_AUTH_PROVIDERS.APPLE); }}
            />
        </View>}
        {children}
    </View>;
}

const styles = StyleSheet.create({
    group: { gap: spacing.sm },
    button: { width: '100%', height: interaction.minimumTouchTarget }
});
