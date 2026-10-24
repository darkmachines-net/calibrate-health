/** @file Profile field validation and canonical normalization for persisted account data. */

import { ActivityLevel, Sex } from '@prisma/client';

/** Type guard for supported sex values stored by Prisma. */
export const isSex = (value: unknown): value is Sex => value === 'MALE' || value === 'FEMALE';

/** Type guard for supported activity levels stored by Prisma. */
export const isActivityLevel = (value: unknown): value is ActivityLevel =>
    value === 'SEDENTARY' ||
    value === 'LIGHT' ||
    value === 'MODERATE' ||
    value === 'ACTIVE' ||
    value === 'VERY_ACTIVE';