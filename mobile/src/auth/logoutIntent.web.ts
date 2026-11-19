/** @file Persistent browser logout intent and cookie-session revocation, coordinated across tabs when Web Locks are available. */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { CalibrateApiClient } from '@calibrate/api-client';
import { createLogoutIntentStore } from './logoutIntentStore';

export const { hasExplicitLogout, beginExplicitLogout, flushExplicitLogout, finishExplicitLogin } = createLogoutIntentStore({
    get: key => AsyncStorage.getItem(key), set: (key, value) => AsyncStorage.setItem(key, value), remove: key => AsyncStorage.removeItem(key)
}, server => new CalibrateApiClient({ baseUrl: server, requestCredentials: 'include' }).logoutBrowser(), true, (key, work) => typeof navigator !== 'undefined' && navigator.locks
    ? navigator.locks.request(key, work)
    : work());
