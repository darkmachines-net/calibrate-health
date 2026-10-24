/** @file layout: Provides headerless nested navigation for settings routes. */

import { Stack } from 'expo-router';

/** Provides headerless nested navigation for settings routes. */
export default function SettingsStackLayout() {
    return <Stack screenOptions={{ headerShown: false }} />;
}
