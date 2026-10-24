/** @file connected apps: Render connected assistants and their revocation controls as a navigable settings page. */

/**
 * Defines the connected assistant management Expo Router screen.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
/**
 * Defines the connected assistant management Expo Router screen.
 */
import { AppSection } from '../../../src/components/AppSection';
/**
 * Defines the connected assistant management Expo Router screen.
 */
import { AppText } from '../../../src/components/AppText';
/**
 * Defines the connected assistant management Expo Router screen.
 */
import {
    AsyncStateBoundary,
    useAsyncResourceState,
    useOnlineStatus
} from '../../../src/components/AsyncStateBoundary';
/**
 * Defines the connected assistant management Expo Router screen.
 */
import { SectionHeader } from '../../../src/components/SectionHeader';
/**
 * Defines the connected assistant management Expo Router screen.
 */
import { TabScreen } from '../../../src/components/TabScreen';
/**
 * Defines the connected assistant management Expo Router screen.
 */
import { useAuth } from '../../../src/auth/AuthContext';
/**
 * Defines the connected assistant management Expo Router screen.
 */
import { getSafeActionErrorMessage } from '../../../src/errors/presentation';
/**
 * Defines the connected assistant management Expo Router screen.
 */
import { ConnectedAppsPanel } from '../../../src/settings/ConnectedAppsPanel';
/**
 * Defines the connected assistant management Expo Router screen.
 */
import { SettingsManagementListSkeleton } from '../../../src/settings/SettingsManagementListSkeleton';

/** Render connected assistants and their revocation controls as a navigable settings page. */
export default function ConnectedAppsScreen() {
    const { api } = useAuth();
    const queryClient = useQueryClient();
    const isOnline = useOnlineStatus();
    const connectedAppsQuery = useQuery({
        queryKey: ['connected-apps'],
        queryFn: () => api.getConnectedApps()
    });
    const connectedAppsState = useAsyncResourceState(
        connectedAppsQuery,
        ({ connections }) => connections.length === 0
    );
    const revokeConnectedApp = useMutation({
        mutationFn: (connectionId: string) => api.revokeConnectedApp(connectionId),
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: ['connected-apps'] });
        }
    });
    const revokeErrorMessage = revokeConnectedApp.error
        ? getSafeActionErrorMessage(
            revokeConnectedApp.error,
            'Unable to revoke that connected assistant.'
        )
        : undefined;

    return (
        <TabScreen contentWidth="overview" testID="connected-apps-settings-page">
            <SectionHeader
                title="Authorized assistants"
                description="Assistants use revocable, read-only OAuth access. They never receive your Calibrate password."
            />
            <AsyncStateBoundary
                state={connectedAppsState}
                resourceLabel="connected assistants"
                loading={<SettingsManagementListSkeleton label="Loading connected assistants" />}
                empty={(
                    <AppSection>
                        <AppText variant="subtitle">No connected assistants</AppText>
                        <AppText variant="muted">Connections you approve will appear here.</AppText>
                    </AppSection>
                )}
                onRetry={isOnline ? () => connectedAppsQuery.refetch() : undefined}
                retrying={connectedAppsQuery.isFetching}
            >
                <ConnectedAppsPanel
                    connections={connectedAppsQuery.data?.connections ?? []}
                    pendingConnectionId={revokeConnectedApp.isPending
                        ? revokeConnectedApp.variables
                        : undefined}
                    errorMessage={revokeErrorMessage}
                    onRevoke={async (connectionId) => {
                        await revokeConnectedApp.mutateAsync(connectionId);
                    }}
                />
            </AsyncStateBoundary>
        </TabScreen>
    );
}
