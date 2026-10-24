/** @file index: Waits for session restoration before routing to Today or sign-in. */

import { Redirect } from 'expo-router';
import { LoadingState } from '../src/components/LoadingState';
import { useAuth } from '../src/auth/AuthContext';

/** Waits for session restoration before routing to Today or sign-in. */
export default function IndexRoute() {
    const { user, isLoading } = useAuth();

    if (isLoading) {
        return <LoadingState label="Preparing calibrate..." />;
    }

    return <Redirect href={user ? '/today' : '/(auth)/login'} />;
}
