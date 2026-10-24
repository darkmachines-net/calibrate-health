/** @file Health Connect Connection Action: One stable connection action shared by Activity and Health Connect settings. */

import { type ComponentProps } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useHealthConnect } from '../healthConnect/provider';
import { useHealthConnectPresentation } from '../healthConnect/useHealthConnectPresentation';
import { useAppTheme } from '../theme';
import { AppButton } from './AppButton';

export type HealthConnectConnectionActionProps = {
    variant?: ComponentProps<typeof AppButton>['variant'];
    style?: StyleProp<ViewStyle>;
};

/** One stable connection action shared by Activity and Health Connect settings. */
export function HealthConnectConnectionAction({
    variant = 'primary',
    style
}: HealthConnectConnectionActionProps) {
    const healthConnect = useHealthConnect();
    const theme = useAppTheme();
    const presentation = useHealthConnectPresentation();

    if (!presentation.action || !presentation.actionLabel) return null;

    let busyLabel = presentation.actionLabel;
    let onPress = healthConnect.manageAccess;
    let iconName: ComponentProps<typeof Ionicons>['name'] = 'settings-outline';
    if (presentation.action === 'connect') {
        busyLabel = 'Connecting...';
        onPress = healthConnect.connect;
        iconName = 'fitness-outline';
    } else if (presentation.action === 'update_provider') {
        busyLabel = 'Opening update...';
        onPress = healthConnect.updateProvider;
        iconName = 'download-outline';
    }

    const iconColor = variant === 'primary' ? theme.colors.onPrimary : theme.colors.onSurface;
    return (
        <AppButton
            title={presentation.actionLabel}
            busy={healthConnect.isBusy}
            busyLabel={busyLabel}
            disabled={healthConnect.isLoading || healthConnect.isSyncing}
            variant={variant}
            leftIcon={<Ionicons name={iconName} size={18} color={iconColor} />}
            onPress={() => void onPress()}
            style={style}
        />
    );
}
