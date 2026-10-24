/** @file health connect: Render Health Connect consent and data-access controls as a navigable settings page. */

/**
 * Defines the Health Connect settings Expo Router screen.
 */
import { HealthConnectCard } from '../../../src/components/HealthConnectCard';
/**
 * Defines the Health Connect settings Expo Router screen.
 */
import { AppText } from '../../../src/components/AppText';
/**
 * Defines the Health Connect settings Expo Router screen.
 */
import { TabScreen } from '../../../src/components/TabScreen';
/**
 * Defines the Health Connect settings Expo Router screen.
 */
import { supportsAndroidIntegrations } from '../../../src/platform/nativePlatform';

/** Render Health Connect consent and data-access controls as a navigable settings page. */
export default function HealthConnectSettingsScreen() {
    return (
        <TabScreen contentWidth="overview" testID="health-connect-settings-page">
            {supportsAndroidIntegrations() ? <HealthConnectCard /> : (
                <AppText>Health Connect is available in the Android app.</AppText>
            )}
        </TabScreen>
    );
}
