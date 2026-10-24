/** @file Explicit non-sensitive Prisma selection and serialization for public user responses. */

import type { ActivityLevel, HeightUnit, Prisma, Sex, WeightUnit } from '@prisma/client';
import { isSupportedLanguage, SUPPORTED_LANGUAGES, type SupportedLanguage } from './language';
import { buildBase64DataUrl } from './profileImage';
import { formatLocalWallClockMinute } from '../services/reminderSchedule';
import {
  ACCOUNT_ACCESS_SELECT,
  serializeAccountAccess,
  type AccountAccess,
  type AccountAccessSource
} from './accountAccessSerialization';

export type UserClientPayload = {
  id: number;
  email: string;
  created_at: Date;
  onboarding_completed_at: Date | null;
  weight_unit: WeightUnit;
  height_unit: HeightUnit;
  timezone: string;
  language: SupportedLanguage;
  reminder_log_weight_enabled: boolean;
  reminder_log_food_enabled: boolean;
  reminder_log_weight_time: string;
  reminder_log_food_time: string;
  reminder_quiet_hours_start: string | null;
  reminder_quiet_hours_end: string | null;
  haptics_enabled: boolean;
  date_of_birth: string | null;
  sex: Sex | null;
  height_mm: number | null;
  activity_level: ActivityLevel | null;
  profile_image_url: string | null;
  account_access: AccountAccess;
};

/**
 * Prisma select helper that matches the fields we expose to the frontend.
 * (Avoids accidentally returning sensitive columns like password_hash.)
 */
export const USER_CLIENT_SELECT = {
  id: true,
  email: true,
  created_at: true,
  onboarding_completed_at: true,
  weight_unit: true,
  height_unit: true,
  timezone: true,
  language: true,
  reminder_log_weight_enabled: true,
  reminder_log_food_enabled: true,
  reminder_log_weight_minute: true,
  reminder_log_food_minute: true,
  reminder_quiet_hours_start_minute: true,
  reminder_quiet_hours_end_minute: true,
  haptics_enabled: true,
  date_of_birth: true,
  sex: true,
  height_mm: true,
  activity_level: true,
  profile_image: true,
  profile_image_mime_type: true,
  ...ACCOUNT_ACCESS_SELECT
} satisfies Prisma.UserSelect;

export type UserForClient = Omit<
  UserClientPayload,
  | 'profile_image_url'
  | 'language'
  | 'date_of_birth'
  | 'account_access'
  | 'reminder_log_weight_time'
  | 'reminder_log_food_time'
  | 'reminder_quiet_hours_start'
  | 'reminder_quiet_hours_end'
> & AccountAccessSource & {
  date_of_birth: Date | null;
  reminder_log_weight_minute: number;
  reminder_log_food_minute: number;
  reminder_quiet_hours_start_minute: number | null;
  reminder_quiet_hours_end_minute: number | null;
  // `User.language` is stored as a string (not a Prisma enum), so validate it before returning to the client.
  language: string;
  profile_image?: Uint8Array | null;
  profile_image_mime_type?: string | null;
};

/**
 * Convert a Prisma user row into the subset (plus avatar) that the frontend expects.
 */
export const serializeUserForClient = (user: UserForClient): UserClientPayload => {
  const bytes = user.profile_image ?? null;
  const mimeType = user.profile_image_mime_type ?? null;

  return {
    id: user.id,
    email: user.email,
    created_at: user.created_at,
    onboarding_completed_at: user.onboarding_completed_at ?? null,
    weight_unit: user.weight_unit,
    height_unit: user.height_unit,
    timezone: user.timezone,
    language: isSupportedLanguage(user.language) ? user.language : SUPPORTED_LANGUAGES.EN,
    reminder_log_weight_enabled: user.reminder_log_weight_enabled,
    reminder_log_food_enabled: user.reminder_log_food_enabled,
    reminder_log_weight_time: formatLocalWallClockMinute(user.reminder_log_weight_minute),
    reminder_log_food_time: formatLocalWallClockMinute(user.reminder_log_food_minute),
    reminder_quiet_hours_start: user.reminder_quiet_hours_start_minute === null
      ? null
      : formatLocalWallClockMinute(user.reminder_quiet_hours_start_minute),
    reminder_quiet_hours_end: user.reminder_quiet_hours_end_minute === null
      ? null
      : formatLocalWallClockMinute(user.reminder_quiet_hours_end_minute),
    haptics_enabled: user.haptics_enabled,
    date_of_birth: user.date_of_birth ? user.date_of_birth.toISOString().slice(0, 10) : null,
    sex: user.sex,
    height_mm: user.height_mm,
    activity_level: user.activity_level,
    profile_image_url: bytes && mimeType ? buildBase64DataUrl({ mimeType, bytes }) : null,
    account_access: serializeAccountAccess(user)
  };
};
