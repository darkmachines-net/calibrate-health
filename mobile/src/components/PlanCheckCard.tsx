/** @file Descriptive 7/14/28-day tracking summaries and saved Sunday reports; no target decisions or mutations. */

import type { ViewProps } from 'react-native';
import { PlanCheckCardView } from './PlanCheckCardView';
export { PlanCheckCardView } from './PlanCheckCardView';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { AppSection } from './AppSection';
import { AppText } from './AppText';
import { AsyncStateBoundary, useAsyncResourceState, useOnlineStatus } from './AsyncStateBoundary';
import { CardHeader } from './CardHeader';
import { calibrationStatusQueryKey } from '../calibration/queryKeys';
import { useAuth } from '../auth/AuthContext';
import { usePendingCalibrationEvidenceMutation } from '../offline/usePendingCalibrationEvidenceMutation';
import { useCurrentLocalDate } from '../hooks/useCurrentLocalDate';

type PlanCheckCardProps = ViewProps & { suppressStaleNotice?: boolean; hideTitle?: boolean };
/** Fetch the current local day's summary, keeping offline writes and midnight rollover visible. */
export function PlanCheckCard({ suppressStaleNotice, hideTitle, ...props }: PlanCheckCardProps) {
    const { api, user } = useAuth();
    const router = useRouter();
    const localDate = useCurrentLocalDate(user?.timezone);
    const query = useQuery({ queryKey: [...calibrationStatusQueryKey, localDate], queryFn: () => api.getPlanCheck() });
    const isOnline = useOnlineStatus();
    const pending = usePendingCalibrationEvidenceMutation();
    // Keep a failed refresh visible while automatic reconnect retries continue using saved data.
    const state = useAsyncResourceState({ ...query, error: query.error ?? query.failureReason }, () => false);
    if (pending) return <AppSection {...props} density="compact">
        {!hideTitle && <CardHeader title="Plan check" density="compact" />}
        <AppText variant="muted">Your latest food and weight entries are syncing before this summary updates.</AppText>
    </AppSection>;
    return <AsyncStateBoundary
        state={state} resourceLabel="plan check"
        loading={<PlanCheckCardView {...props} hideTitle={hideTitle} isLoading />}
        empty={null} onRetry={isOnline ? () => query.refetch() : undefined}
        retrying={query.isFetching} suppressStaleNotice={suppressStaleNotice}
    >
        <PlanCheckCardView {...props} hideTitle={hideTitle} status={query.data} onLogWeight={() => router.push('/weight')} />
    </AsyncStateBoundary>;
}
