/** @file Preserve the validated barcode return across auth screens. */
import { Platform } from 'react-native';
import type { Href } from 'expo-router';
import { resolveBarcodeAuthDestination, type BarcodeAuthReturnParams } from '../barcode/authReturn';

export type AuthEntryParams = BarcodeAuthReturnParams & {
    method?: string | string[];
};

export const EMAIL_SIGN_IN_METHOD = 'email';

/** Keep public browser URLs stable and carry only validated continuation fields between native screens. */
export function authEntryHref(
    destination: 'welcome' | 'email' | 'register',
    params: AuthEntryParams = {}
): Href {
    const native = Platform.OS !== 'web';
    if (destination === 'welcome' && !native) return '/';

    const pathname = destination === 'register' ? '/(auth)/register' : '/(auth)/login';
    const barcode = resolveBarcodeAuthDestination(params);
    const query = {
        ...(barcode ? { barcodeAuthReturn: params.barcodeAuthReturn as string, ...barcode.params } : {}),
        ...(native && destination === 'email' ? { method: EMAIL_SIGN_IN_METHOD } : {})
    };
    return Object.keys(query).length ? { pathname, params: query } : pathname;
}
