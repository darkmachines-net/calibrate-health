/** @file Singleton operator capability configuration with safe defaults for optional features. */

import prisma from '../config/database';

// A single row owns instance-wide settings; a missing row keeps experiments off.
const SERVER_SETTINGS_ID = 1;

/** Read singleton operator capabilities, defaulting optional label scanning to disabled before configuration. */
export async function getServerFeatures() {
  const settings = await prisma.serverSettings.findUnique({ where: { id: SERVER_SETTINGS_ID } });
  return { nutrition_label_scanning: settings?.nutrition_label_scanning_enabled ?? false };
}

/** Upsert the operator-controlled label-scanning capability and return its public feature shape. */
export async function updateServerFeatures(nutritionLabelScanning: boolean) {
  const settings = await prisma.serverSettings.upsert({
    where: { id: SERVER_SETTINGS_ID },
    create: { id: SERVER_SETTINGS_ID, nutrition_label_scanning_enabled: nutritionLabelScanning },
    update: { nutrition_label_scanning_enabled: nutritionLabelScanning }
  });
  return { nutrition_label_scanning: settings.nutrition_label_scanning_enabled };
}

/** Require an explicitly allowlisted account ID plus current existence and verified-email state for every admin check. */
export async function isServerAdmin(userId: number): Promise<boolean> {
  // Operators bind grants to existing accounts; disabled email delivery can auto-verify emails.
  const allowedUserIds = new Set((process.env.ADMIN_USER_IDS ?? '').split(',')
    .map((id) => id.trim()).filter((id) => /^[1-9]\d*$/.test(id)));
  if (!allowedUserIds.has(String(userId))) return false;
  // Recheck account existence and verification status for every request.
  const user = await prisma.user.findUnique({
    where: { id: userId }, select: { email_verified_at: true }
  });
  return Boolean(user?.email_verified_at);
}
