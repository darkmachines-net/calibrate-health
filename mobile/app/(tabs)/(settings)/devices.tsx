/** @file devices: Render account sessions and their revocation controls as a navigable settings page. */

/**
 * Defines the signed-in device management Expo Router screen.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
/**
 * Defines the signed-in device management Expo Router screen.
 */
import { AppSection } from '../../../src/components/AppSection';
/**
 * Defines the signed-in device management Expo Router screen.
 */
import { AppText } from '../../../src/components/AppText';
/**
 * Defines the signed-in device management Expo Router screen.
 */
import {
    AsyncStateBoundary,
    useAsyncResourceState,
    useOnlineStatus
} from '../../../src/components/AsyncStateBoundary';
/**
 * Defines the signed-in device management Expo Router screen.
 */
import { SectionHeader } from '../../../src/components/SectionHeader';
/**
 * Defines the signed-in device management Expo Router screen.
 */
import { TabScreen } from '../../../src/components/TabScreen';
/**
 * Defines the signed-in device management Expo Router screen.
 */
import { useAuth } from '../../../src/auth/AuthContext';
/**
 * Defines the signed-in device management Expo Router screen.
 */
import { getSafeActionErrorMessage } from '../../../src/errors/presentation';
/**
 * Defines the signed-in device management Expo Router screen.
 */
import { AccountSessionsPanel } from '../../../src/settings/AccountSessionsPanel';
/**
 * Defines the signed-in device management Expo Router screen.
 */
import { SettingsManagementListSkeleton } from '../../../src/settings/SettingsManagementListSkeleton';

/** Render account sessions and their revocation controls as a navigable settings page. */
export default function SignedInDevicesScreen() {
    const { api } = useAuth();
    const queryClient = useQueryClient();
    const isOnline = useOnlineStatus();
    const sessionsQuery = useQuery({
        queryKey: ['account-sessions'],
        queryFn: () => api.getAccountSessions()
    });
    const sessionsState = useAsyncResourceState(
        sessionsQuery,
        ({ sessions }) => sessions.length === 0
    );
    const revokeSession = useMutation({
        mutationFn: (sessionId: string) => api.revokeAccountSession(sessionId),
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: ['account-sessions'] });
        }
    });
    const revokeOtherSessions = useMutation({
        mutationFn: () => api.revokeOtherAccountSessions(),
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: ['account-sessions'] });
        }
    });
    const revokeError = revokeSession.error ?? revokeOtherSessions.error;
    const revokeErrorMessage = revokeError
        ? getSafeActionErrorMessage(revokeError, 'Unable to revoke that signed-in session.')
        : undefined;

    return (
        <TabScreen contentWidth="overview" testID="signed-in-devices-settings-page">
            <SectionHeader
                title="Account access"
                description="Review every browser, Android, iOS, and Wear OS session for this account."
            />
            <AsyncStateBoundary
                state={sessionsState}
                resourceLabel="signed-in sessions"
                loading={<SettingsManagementListSkeleton label="Loading active devices" />}
                empty={(
                    <AppSection>
                        <AppText variant="subtitle">No signed-in sessions found</AppText>
                        <AppText variant="muted">Refresh to check this account again.</AppText>
                    </AppSection>
                )}
                onRetry={isOnline ? () => sessionsQuery.refetch() : undefined}
                retrying={sessionsQuery.isFetching}
            >
                <AccountSessionsPanel
                    sessions={sessionsQuery.data?.sessions ?? []}
                    pendingSessionId={revokeSession.isPending ? revokeSession.variables : undefined}
                    revokingOthers={revokeOtherSessions.isPending}
                    errorMessage={revokeErrorMessage}
                    onRevoke={async (sessionId) => {
                        await revokeSession.mutateAsync(sessionId);
                    }}
                    onRevokeOthers={async () => {
                        await revokeOtherSessions.mutateAsync();
                    }}
                />
            </AsyncStateBoundary>
        </TabScreen>
    );
}
