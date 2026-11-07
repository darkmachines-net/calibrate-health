/** @file Select one credential authority per deployment and reject incomplete Firebase or production emulator configuration. */

/** Return the explicitly selected authority; local remains the portable self-hosting default. */
export function usesFirebaseAuthentication(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AUTH_PROVIDER?.trim().toLowerCase() === 'firebase';
}

/** Validate startup configuration before accepting credentials; never fall back to local passwords on Firebase failure. */
export function validateCredentialProviderConfiguration(env: NodeJS.ProcessEnv = process.env): void {
  const provider = env.AUTH_PROVIDER?.trim().toLowerCase() || 'local';
  if (!['local', 'firebase'].includes(provider)) throw new Error('AUTH_PROVIDER must be local or firebase.');
  if (provider === 'firebase') {
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(env.FIREBASE_PROJECT_ID ?? '') ||
        !env.FIREBASE_API_KEY?.trim() || !env.FIREBASE_SERVICE_ACCOUNT?.trim()) {
      throw new Error('Firebase authentication requires FIREBASE_PROJECT_ID, FIREBASE_API_KEY and FIREBASE_SERVICE_ACCOUNT.');
    }
    if (env.FIREBASE_AUTH_EMULATOR_HOST && ['production', 'staging'].includes(env.NODE_ENV ?? '')) {
      throw new Error('Firebase Auth emulator credentials are forbidden in production and staging.');
    }
  }
}
