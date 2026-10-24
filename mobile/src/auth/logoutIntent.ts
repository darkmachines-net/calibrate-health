/** @file Native logout-intent platform contract; browser cross-tab coordination is supplied by the web module. */

import * as SecureStore from 'expo-secure-store';
import { CalibrateApiClient } from '@calibrate/api-client';
import { MOBILE_CLIENT_IDENTITY } from '../config/nativeClient';
import { createLogoutIntentStore } from './logoutIntentStore';

export const { hasExplicitLogout, beginExplicitLogout, flushExplicitLogout, finishExplicitLogin, enqueueRevocation: queueNativeRevocation } = createLogoutIntentStore({
    get: key => SecureStore.getItemAsync(key), set: (key, value) => SecureStore.setItemAsync(key, value), remove: key => SecureStore.deleteItemAsync(key)
}, (server, token) => new CalibrateApiClient({ baseUrl: server, clientIdentity: MOBILE_CLIENT_IDENTITY }).logoutMobile(token), false);
