/** @file watch: Render phone-to-watch pairing controls as a navigable settings page. */

/**
 * Defines the Wear OS pairing settings Expo Router screen.
 */
import { TabScreen } from '../../../src/components/TabScreen';
/**
 * Defines the Wear OS pairing settings Expo Router screen.
 */
import { AppText } from '../../../src/components/AppText';
/**
 * Defines the Wear OS pairing settings Expo Router screen.
 */
import { WearPairingCard } from '../../../src/components/WearPairingCard';
/**
 * Defines the Wear OS pairing settings Expo Router screen.
 */
import { supportsAndroidIntegrations } from '../../../src/platform/nativePlatform';

/** Render phone-to-watch pairing controls as a navigable settings page. */
export default function WatchSettingsScreen() {
    return (
        <TabScreen contentWidth="overview" testID="watch-settings-page">
            {supportsAndroidIntegrations() ? <WearPairingCard /> : (
                <AppText>Galaxy Watch pairing is available in the Android app.</AppText>
            )}
        </TabScreen>
    );
}
