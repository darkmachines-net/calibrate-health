/** @file credential Provider: No Firebase runtime activation until registration, recovery, deletion and security reconciliation land together. */

/** No Firebase runtime activation until registration, recovery, deletion and security reconciliation land together. */
export function validateCredentialProviderConfiguration(env: NodeJS.ProcessEnv = process.env): void {
  const provider = env.AUTH_PROVIDER?.trim().toLowerCase() || 'local';
  if (provider !== 'local') {
    throw new Error('AUTH_PROVIDER must remain local: Firebase runtime lifecycle integration is not enabled.');
  }
}
