/** @file layout: Adds date navigation only on the food-log route within the Today stack. */

import { StyleSheet, View } from 'react-native';
import { Stack, usePathname } from 'expo-router';
import { DateNavigationHeader } from '../../../src/components/DateNavigationHeader';
import { useSharedLogDateNavigation } from '../../../src/context/LogDateContext';
import { getRouteByPath } from '../../../src/navigation/routeRegistry';

/** Adds date navigation only on the food-log route within the Today stack. */
export default function TodayStackLayout() {
    const pathname = usePathname();
    const dateNavigation = useSharedLogDateNavigation();
    const activeRoute = getRouteByPath(pathname);
    const showsDateNavigation = activeRoute?.routeId === 'food-log';

    return (
        <View style={styles.root}>
            {showsDateNavigation && <DateNavigationHeader
                navigation={dateNavigation}
                contentWidth="wide"
            />}
            <View style={styles.stack}>
                <Stack screenOptions={{ headerShown: false }} />
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    root: {
        flex: 1
    },
    stack: {
        flex: 1
    }
});
