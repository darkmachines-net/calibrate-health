/** @file +not found: Returns unknown native routes to the main Today destination. */

import { Redirect } from 'expo-router';

/** Returns unknown native routes to the main Today destination. */
export default function NotFoundScreen() {
    return <Redirect href="/today" />;
}
