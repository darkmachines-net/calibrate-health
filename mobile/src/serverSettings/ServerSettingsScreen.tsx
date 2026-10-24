/** @file Server Settings Screen: Presents administrator feature controls and refreshes authoritative server settings after changes. */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Redirect } from 'expo-router';
import { useAuth } from '../auth/AuthContext';
import { AppButton } from '../components/AppButton';
import { AppNotice } from '../components/AppNotice';
import { AppSection } from '../components/AppSection';
import { AppText } from '../components/AppText';
import { PreferenceSwitch } from '../settings/SettingsPrimitives';
import { useOnlineStatus } from '../components/AsyncStateBoundary';
import { SectionHeader } from '../components/SectionHeader';
import { SkeletonBlock } from '../components/SkeletonBlock';
import { TabScreen } from '../components/TabScreen';
import { getSafeActionErrorMessage } from '../errors/presentation';
import { serverSettingsQueryKey, useServerSettings } from './useServerSettings';

// Reserve the settings control's space while its server value loads.
const SETTINGS_PLACEHOLDER_HEIGHT = 64;

/** Presents administrator feature controls and refreshes authoritative server settings after changes. */
export default function ServerSettingsScreen() {
    const { api, user, isLoading, serverUrl } = useAuth();
    const settings = useServerSettings();
    const queryClient = useQueryClient();
    const isOnline = useOnlineStatus();
    const mutation = useMutation({
        mutationFn: (enabled: boolean) => api.updateServerSettings({ nutrition_label_scanning: enabled }),
        onSuccess: async (response) => {
            const queryKey = serverSettingsQueryKey(serverUrl, user?.id);
            await queryClient.cancelQueries({ queryKey });
            queryClient.setQueryData(queryKey, response);
        }
    });
    let toggleStatus = settings.nutritionLabelScanning ? 'On' : 'Off';
    if (mutation.isPending) toggleStatus = 'Saving setting...';

    if (!isLoading && !user) return <Redirect href="/login" />;

    let content;
    if (!isOnline) {
        content = <AppNotice tone="warning"><AppText>Connect to the server to manage its settings.</AppText></AppNotice>;
    } else if (settings.isPending || isLoading) {
        content = <AppSection><AppText>Loading server settings...</AppText><SkeletonBlock height={SETTINGS_PLACEHOLDER_HEIGHT} /></AppSection>;
    } else if (settings.isError) {
        content = <AppSection>
            <AppNotice tone="danger" accessibilityRole="alert"><AppText>Server settings could not be loaded.</AppText></AppNotice>
            <AppButton title="Try again" variant="secondary" onPress={() => void settings.refetch()} />
        </AppSection>;
    } else if (!settings.isAdmin) {
        content = <AppNotice tone="warning"><AppText>Server administrator access is required to change these settings.</AppText></AppNotice>;
    } else {
        content = <AppSection>
            <SectionHeader title="Experimental features" description="Changes apply to everyone using this server. They are saved immediately." />
            <PreferenceSwitch
                label="Nutrition label scanning"
                value={settings.nutritionLabelScanning}
                disabled={mutation.isPending}
                onValueChange={(enabled) => mutation.mutate(enabled)}
            />
            <AppText accessibilityLiveRegion="polite">{toggleStatus}</AppText>
            <AppText variant="muted">Read calories and serving sizes from a label photo. Results may be incomplete or inaccurate and must be reviewed before saving.</AppText>
            <AppText variant="caption">Turning this off blocks new scans immediately. Saved foods are unaffected.</AppText>
            {mutation.isError && <AppNotice tone="danger" accessibilityRole="alert"><AppText>{getSafeActionErrorMessage(mutation.error, 'The setting could not be saved. Try again.')}</AppText></AppNotice>}
            {mutation.isSuccess && <AppText accessibilityLiveRegion="polite">Server settings saved.</AppText>}
        </AppSection>;
    }

    return <TabScreen contentWidth="form">
        <AppSection>
            <SectionHeader title="Server administration" description="Manage settings for the connected Calibrate server." />
            <AppText variant="caption" selectable>{serverUrl}</AppText>
        </AppSection>
        {content}
    </TabScreen>;
}
