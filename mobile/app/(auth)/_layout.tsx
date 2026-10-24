/** @file layout: Guards authentication routes and resumes the requested barcode or Today destination after sign-in. */

import { Redirect, Stack, useLocalSearchParams, useSegments } from 'expo-router';
import { LoadingState } from '../../src/components/LoadingState';
import { useAuth } from '../../src/auth/AuthContext';
import {
    resolveBarcodeAuthDestination,
    type BarcodeAuthReturnParams
} from '../../src/barcode/authReturn';

/** Guards authentication routes and resumes the requested barcode or Today destination after sign-in. */
export default function AuthLayout() {
    const { user, isLoading, accountDeletionCleanupNotice } = useAuth();
    const segments = useSegments();
    const params = useLocalSearchParams<BarcodeAuthReturnParams>();

    if (isLoading) {
        return <LoadingState />;
    }

    if (user) {
        return <Redirect href={resolveBarcodeAuthDestination(params) ?? '/today'} />;
    }

    if (accountDeletionCleanupNotice && segments[0] !== 'login') {
        return <Redirect href="/(auth)/login" />;
    }

    return <Stack screenOptions={{ headerShown: false }} />;
}
