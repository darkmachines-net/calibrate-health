/** @file Progress Expansion Content: Renders the selected expanded Progress section inside the shared overview layout. */

import { StyleSheet } from 'react-native';
import { PlanCheckCard } from '../components/PlanCheckCard';
import { WeightTrendCard } from '../components/WeightTrendCard';
import { TabScreen } from '../components/TabScreen';

/** Renders the selected expanded Progress section inside the shared overview layout. */
export default function ProgressExpansionContent({ section }: { section: string }) {
    return <TabScreen contentWidth="overview" style={styles.content}>
        {section === 'trend' ? <WeightTrendCard title={null} style={styles.trend} /> : <PlanCheckCard hideTitle />}
    </TabScreen>;
}

const styles = StyleSheet.create({
    content: { paddingTop: 0 },
    trend: { flexGrow: 1, width: '100%' }
});
