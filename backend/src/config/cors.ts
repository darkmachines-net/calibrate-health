/** @file cors: Normalize an Origin header or CORS allowlist entry for comparison. */

const DEVELOPMENT_LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const BROWSER_PROTOCOLS = new Set(['http:', 'https:']);

export type BrowserOriginPolicy = {
  exactOrigins: ReadonlySet<string>;
  allowDevelopmentLoopbackOrigins: boolean;
};

/** Normalize an Origin header or CORS allowlist entry for comparison. */
export function normalizeBrowserOrigin(origin: string): string | null {
  try {
    return new URL(origin).origin;
  } catch {
    return null;
  }
}

/**
 * Build the browser-origin policy for the current environment.
 *
 * Development accepts loopback web dev servers on any port in addition to exact
 * CORS_ORIGINS entries. Deployed environments remain exact-origin only.
 */
export function resolveBrowserOriginPolicy(
  configuredOrigins: string | undefined,
  isProductionOrStaging: boolean
): BrowserOriginPolicy {
  const exactOrigins = new Set<string>();

  for (const configuredOrigin of configuredOrigins?.split(',') ?? []) {
    const normalizedOrigin = normalizeBrowserOrigin(configuredOrigin.trim());
    if (normalizedOrigin) exactOrigins.add(normalizedOrigin);
  }

  return {
    exactOrigins,
    allowDevelopmentLoopbackOrigins: !isProductionOrStaging
  };
}

/** Return whether an HTTP(S) browser origin uses a trusted loopback hostname. */
export function isDevelopmentLoopbackOrigin(origin: string): boolean {
  try {
    const parsedOrigin = new URL(origin);
    return BROWSER_PROTOCOLS.has(parsedOrigin.protocol) && DEVELOPMENT_LOOPBACK_HOSTS.has(parsedOrigin.hostname);
  } catch {
    return false;
  }
}

/** Return whether an origin is allowed by the environment's cross-origin policy. */
export function isOriginTrustedByPolicy(origin: string, policy: BrowserOriginPolicy): boolean {
  const normalizedOrigin = normalizeBrowserOrigin(origin);
  if (!normalizedOrigin) return false;

  return (
    policy.exactOrigins.has(normalizedOrigin) ||
    (policy.allowDevelopmentLoopbackOrigins && isDevelopmentLoopbackOrigin(normalizedOrigin))
  );
}
