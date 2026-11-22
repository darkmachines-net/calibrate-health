/** @file Authenticated goal setup route with optional preselection of a goal type. */

import { Redirect, router, useIsFocused, useLocalSearchParams } from 'expo-router';
import type { GoalStatus } from '@calibrate/api-client';
import { isNullResource } from '../../src/asyncState/resolveAsyncState';
import { useAuth } from '../../src/auth/AuthContext';
import { AppText } from '../../src/components/AppText';
import { AsyncStateBoundary, useAsyncResourceState, useOnlineStatus } from '../../src/components/AsyncStateBoundary';
import { LoadingState } from '../../src/components/LoadingState';
import { TabScreen } from '../../src/components/TabScreen';
import { MaintenanceGoalEditor } from '../../src/progress/MaintenanceGoalEditor';
import { useGoalStatus } from '../../src/progress/useGoalStatus';

/** Open goal setup against current server data and return to the launch route on exit. */
export default function GoalSetupScreen() {
    const { mode } = useLocalSearchParams<{ mode?: string }>();
    const { user, serverUrl } = useAuth();
    const focused = useIsFocused();
    const lifecycle = useGoalStatus(focused);
    const request = lifecycle.supported ? lifecycle : lifecycle.capability;
    const state = useAsyncResourceState<GoalStatus | boolean | null>(request, isNullResource);
    const isOnline = useOnlineStatus();
    const initialMode = mode === 'maintain' || mode === 'gain' ? mode : 'lose';

    function exit() {
        if (router.canGoBack()) router.back();
        else router.replace('/progress');
    }

    // The tab navigator retains this route after leaving. A new visit needs a new review snapshot.
    if (!focused) return null;
    if (lifecycle.capability.data === false) return <Redirect href="/progress" />;
    if (lifecycle.data) return <MaintenanceGoalEditor key={`${serverUrl}/${user?.id}/${initialMode}`}
        status={lifecycle.data} intent="new" initialMode={initialMode} onClose={exit} />;
    return <TabScreen contentWidth="form" testID="goal-setup-page">
        <AsyncStateBoundary state={state} resourceLabel="goal setup"
            loading={<LoadingState label="Loading goal setup..." />}
            empty={<AppText variant="muted">Goal setup is unavailable. Go back and try again.</AppText>}
            onRetry={isOnline ? () => request.refetch() : undefined} retrying={request.isFetching}>
            {null}
        </AsyncStateBoundary>
    </TabScreen>;
}
