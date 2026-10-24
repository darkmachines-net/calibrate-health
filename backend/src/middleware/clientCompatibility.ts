/** @file client Compatibility: Enforce release floors on every bearer-authenticated request and the unauthenticated Wear exchange. Browser cookie sessions omit native identity headers and remain unaffected. */

import type { NextFunction, Request, Response } from 'express';
import {
  CLIENT_UPGRADE_REQUIRED_CODE,
  NATIVE_CLIENT_HEADERS,
  compareClientVersions,
  isMobileDevicePlatform,
  type MobileDevicePlatform
} from '../../../shared/clientCompatibility';
import { MOBILE_DEVICE_PLATFORMS } from '../../../shared/domain';
import release from '../../../shared/release.json';

const WEAR_PAIRING_EXCHANGE_PATH = '/auth/mobile/wear/pair';
const MAX_VERSION_HEADER_LENGTH = 64;

function minimumVersion(platform: MobileDevicePlatform): string {
  return platform === MOBILE_DEVICE_PLATFORMS.WEAR_OS
    ? release.android.wear.minimum_supported_version
    : release.android.mobile.minimum_supported_version;
}

function platformLabel(platform: MobileDevicePlatform): string {
  switch (platform) {
    case MOBILE_DEVICE_PLATFORMS.IOS:
      return 'Calibrate for iOS';
    case MOBILE_DEVICE_PLATFORMS.WEAR_OS:
      return 'Calibrate for Wear OS';
    default:
      return 'Calibrate for Android';
  }
}

/**
 * Enforce release floors on every bearer-authenticated request and the unauthenticated Wear exchange.
 * Browser cookie sessions omit native identity headers and remain unaffected.
 */
export function enforceNativeClientCompatibility(req: Request, res: Response, next: NextFunction) {
  const trustedPlatform = isMobileDevicePlatform(res.locals.mobileDevicePlatform)
    ? res.locals.mobileDevicePlatform
    : null;
  const requiredPathPlatform = req.path.endsWith(WEAR_PAIRING_EXCHANGE_PATH)
    ? MOBILE_DEVICE_PLATFORMS.WEAR_OS
    : null;
  const suppliedPlatformValue = req.get(NATIVE_CLIENT_HEADERS.PLATFORM)?.trim();
  const suppliedPlatform = isMobileDevicePlatform(suppliedPlatformValue) ? suppliedPlatformValue : null;
  const expectedPlatform = trustedPlatform ?? requiredPathPlatform;

  if (suppliedPlatformValue && !suppliedPlatform) {
    return res.status(400).json({
      message: 'Invalid Calibrate native client platform.',
      code: 'CLIENT_PLATFORM_INVALID',
      retryable: false
    });
  }
  if (expectedPlatform && suppliedPlatform && suppliedPlatform !== expectedPlatform) {
    return res.status(400).json({
      message: 'Native client identity does not match the authenticated device session.',
      code: 'CLIENT_PLATFORM_MISMATCH',
      retryable: false
    });
  }

  const platform = expectedPlatform ?? suppliedPlatform;
  if (!platform) return next();

  const suppliedVersion = req.get(NATIVE_CLIENT_HEADERS.VERSION)?.trim() ?? null;
  const boundedVersion = suppliedVersion && suppliedVersion.length <= MAX_VERSION_HEADER_LENGTH
    ? suppliedVersion
    : null;
  const minimum = minimumVersion(platform);
  const comparison = boundedVersion ? compareClientVersions(boundedVersion, minimum) : null;
  if (comparison === null || comparison < 0) {
    res.setHeader(NATIVE_CLIENT_HEADERS.MINIMUM_VERSION, minimum);
    return res.status(426).json({
      message: `Update ${platformLabel(platform)} to version ${minimum} or newer to continue.`,
      code: CLIENT_UPGRADE_REQUIRED_CODE,
      platform,
      current_version: comparison === null ? null : boundedVersion,
      minimum_supported_version: minimum,
      retryable: false
    });
  }

  res.locals.nativeClientVersion = boundedVersion;
  return next();
}
