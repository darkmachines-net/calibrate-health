/** @file plan check: Hosts the full plan-check surface within the Progress tab layout. */

import { PlanCheckCard } from '../../../src/components/PlanCheckCard';
import { TabScreen } from '../../../src/components/TabScreen';

/** Hosts the full plan-check surface within the Progress tab layout. */
export default function PlanCheckScreen() {
    return (
        <TabScreen contentWidth="overview">
            <PlanCheckCard />
        </TabScreen>
    );
}
