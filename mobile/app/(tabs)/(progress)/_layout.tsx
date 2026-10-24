/** @file layout: Provides headerless nested navigation for Progress routes. */

import { Stack } from 'expo-router';

/** Provides headerless nested navigation for Progress routes. */
export default function ProgressStackLayout() {
    return <Stack screenOptions={{ headerShown: false }} />;
}
