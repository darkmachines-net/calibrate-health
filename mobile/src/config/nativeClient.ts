/** @file native Client: Server contract version expected by the JavaScript bundle, independent of the native app version. */

import * as Application from 'expo-application';
import type { NativeClientIdentity } from '@calibrate/shared';
import appConfig from '../../app.json';
import release from '../../../shared/release.json';
import { getMobileDevicePlatform } from '../platform/nativePlatform';

/** Server contract version expected by the JavaScript bundle, independent of the native app version. */
export const MOBILE_SERVER_RELEASE_VERSION = release.server.version;

/** Native version is authoritative on-device; Expo config is a safe native/Jest fallback. */
export const MOBILE_CLIENT_IDENTITY = {
    platform: getMobileDevicePlatform(),
    version: Application.nativeApplicationVersion?.trim() || appConfig.expo.version
} satisfies NativeClientIdentity;
