/** @file Public browser welcome and session-aware redirect for returning users. */
import { Redirect } from 'expo-router';
import { AuthWelcome } from '../src/components/auth/AuthWelcome';
import { LoadingState } from '../src/components/LoadingState';
import { useAuth } from '../src/auth/AuthContext';

/** Restore the browser session before choosing the public welcome or Today. */
export default function WebHomeRoute() {
    const { user, isLoading } = useAuth();
    if (isLoading) return <LoadingState label="Opening Calibrate..." />;
    if (user) return <Redirect href="/today" />;
    return <AuthWelcome browser />;
}
