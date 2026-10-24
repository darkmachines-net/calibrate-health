/** @file product: Canonical product identity and public destinations shared by every client and server. */

/** Canonical product identity and public destinations shared by every client and server. */
export const CALIBRATE_PRODUCT_NAME = 'Calibrate';
export const CALIBRATE_HOSTED_ORIGIN = 'https://calibratehealth.app';
export const CALIBRATE_PROJECT_URL = 'https://github.com/MChartier/calibrate-health';

/**
 * Public routes stay relative so self-hosted instances keep users on their own operator's
 * legal and support surfaces. Feedback intentionally uses the established support route.
 */
export const CALIBRATE_PRODUCT_LINKS = {
  product: CALIBRATE_HOSTED_ORIGIN,
  support: '/support',
  feedback: '/support',
  privacy: '/privacy',
  terms: '/terms',
  licenses: `${CALIBRATE_PROJECT_URL}/blob/master/LICENSE`,
  releases: `${CALIBRATE_PROJECT_URL}/releases`
} as const;
