/** @file Named runtime environment predicates used to separate development behavior from deployed services. */

/**
 * Determine whether a NODE_ENV value indicates a deployed environment (production or staging).
 *
 * We treat "staging" the same as "production" so our staging deployments behave like
 * production (secure cookies by default, no dev-only routes, etc.).
 *
 * Self-hosting note: if you're running this app as an actual deployment (even on a home server),
 * set NODE_ENV=production so you get the deployed defaults. You can still override cookie behavior
 * via SESSION_COOKIE_SECURE/SESSION_COOKIE_DOMAIN/etc when needed.
 */
export const isProductionOrStagingEnv = (nodeEnv: string | undefined): boolean =>
  nodeEnv === 'production' || nodeEnv === 'staging';
