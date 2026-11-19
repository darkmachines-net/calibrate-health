/** @file plan check: Hosts the full plan-check surface within the Progress tab layout. */

import { PlanCheckCard } from '../../../src/components/PlanCheckCard';
import { TabScreen } from '../../../src/components/TabScreen';
import { Redirect } from 'expo-router';
import { useGoalStatus } from '../../../src/progress/useGoalStatus';

/** Hosts the full plan-check surface within the Progress tab layout. */
export default function PlanCheckScreen() {
    const { data } = useGoalStatus();
    if (data?.maintenance || data?.goal?.completed_on) return <Redirect href="/progress" />;
    return (
        <TabScreen contentWidth="overview">
            <PlanCheckCard />
        </TabScreen>
    );
}
