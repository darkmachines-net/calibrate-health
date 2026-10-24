/** @file Bounded native device identity parsing and account-scoped device metadata handling. */

import { MobileDevicePlatform } from '@prisma/client';
import {
  MOBILE_DEVICE_PLATFORMS,
  type MobileDevicePlatform as MobileDevicePlatformWire
} from '../../../shared/domain';

export const MAX_DEVICE_ID_LENGTH = 128;
const MAX_DEVICE_NAME_LENGTH = 120;

export type ParsedMobileDevice = {
  deviceId: string;
  devicePlatform: MobileDevicePlatform;
  deviceName: string | null;
};

type ParseMobileDeviceResult =
  | { ok: true; device: ParsedMobileDevice }
  | { ok: false; message: string };

/** Trim a required bounded string, returning null for nontext, empty or oversized values. */
export const normalizeRequiredText = (value: unknown, maxLength: number): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return null;
  return trimmed;
};

const normalizeOptionalText = (value: unknown, maxLength: number): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
};

const parseMobileDevicePlatform = (value: unknown): MobileDevicePlatform | null => {
  if (value === undefined || value === null || value === MOBILE_DEVICE_PLATFORMS.ANDROID_PHONE) {
    return MobileDevicePlatform.ANDROID_PHONE;
  }
  if (value === MOBILE_DEVICE_PLATFORMS.IOS) {
    return MobileDevicePlatform.IOS;
  }
  if (value === MOBILE_DEVICE_PLATFORMS.WEAR_OS) {
    return MobileDevicePlatform.WEAR_OS;
  }
  return null;
};

/** Translate persisted device platforms into supported native wire values, defaulting to Android phone. */
export const serializeMobileDevicePlatform = (
  value: MobileDevicePlatform
): MobileDevicePlatformWire => {
  switch (value) {
    case MobileDevicePlatform.IOS:
      return MOBILE_DEVICE_PLATFORMS.IOS;
    case MobileDevicePlatform.WEAR_OS:
      return MOBILE_DEVICE_PLATFORMS.WEAR_OS;
    default:
      return MOBILE_DEVICE_PLATFORMS.ANDROID_PHONE;
  }
};

/** Validate native device metadata sent with login/register. */
export const parseMobileDevicePayload = (body: unknown): ParseMobileDeviceResult => {
  if (!body || typeof body !== 'object') {
    return { ok: false, message: 'Invalid request body' };
  }

  const record = body as Record<string, unknown>;
  const deviceId = normalizeRequiredText(record.device_id, MAX_DEVICE_ID_LENGTH);
  if (!deviceId) {
    return { ok: false, message: 'device_id is required' };
  }

  const devicePlatform = parseMobileDevicePlatform(record.device_platform);
  if (!devicePlatform) {
    return { ok: false, message: 'Invalid device_platform' };
  }

  return {
    ok: true,
    device: {
      deviceId,
      devicePlatform,
      deviceName: normalizeOptionalText(record.device_name, MAX_DEVICE_NAME_LENGTH)
    }
  };
};
