/** @file goals: Redirects the legacy goals route to the canonical Progress overview. */

import { Redirect } from 'expo-router';

/** Redirects the legacy goals route to the canonical Progress overview. */
export default function GoalsScreen() {
    return <Redirect href="/progress" />;
}
