/** @file weight trend: Hosts the full weight-trend chart as a dedicated Progress route. */

import { StyleSheet } from 'react-native';
import { TabScreen } from '../../../src/components/TabScreen';
import { WeightTrendCard } from '../../../src/components/WeightTrendCard';

/** Hosts the full weight-trend chart as a dedicated Progress route. */
export default function WeightTrendScreen() {
    return (
        <TabScreen>
            <WeightTrendCard
                title={null}
                style={styles.trendCard}
            />
        </TabScreen>
    );
}

const styles = StyleSheet.create({
    trendCard: {
        flexGrow: 1,
        width: '100%'
    }
});
