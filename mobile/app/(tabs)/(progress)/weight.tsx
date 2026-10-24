/** @file weight: Opens dated weight entry on each focus and restores navigation when the entry sheet closes. */

import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { DateNavigationHeader } from '../../../src/components/DateNavigationHeader';
import { TabScreen } from '../../../src/components/TabScreen';
import { WeightEntrySheet } from '../../../src/components/WeightEntrySheet';
import { useLogDateNavigation } from '../../../src/hooks/useLogDateNavigation';

/** Opens dated weight entry on each focus and restores navigation when the entry sheet closes. */
export default function WeightScreen() {
    const router = useRouter();
    const { date } = useLocalSearchParams<{ date?: string }>();
    const dateNavigation = useLogDateNavigation(typeof date === 'string' ? date : null);
    const [isSheetOpen, setIsSheetOpen] = useState(true);

    // Tab stacks retain this route when Back returns to Today. Reopen it on the next visit.
    useFocusEffect(useCallback(() => {
        setIsSheetOpen(true);
        return () => setIsSheetOpen(false);
    }, []));

    function closeSheet() {
        setIsSheetOpen(false);
        if (router.canGoBack()) {
            router.back();
            return;
        }
        router.replace('/progress');
    }

    return (
        <View style={styles.screen}>
            <DateNavigationHeader navigation={dateNavigation} />
            <TabScreen>
                <WeightEntrySheet
                    visible={isSheetOpen}
                    date={dateNavigation.selectedDate}
                    onClose={closeSheet}
                />
            </TabScreen>
        </View>
    );
}

const styles = StyleSheet.create({
    screen: { flex: 1 }
});
