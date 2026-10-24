/** @file Explicit native push opt-in and provider configuration for self-hosted servers. */

export const NATIVE_PUSH_MODES = {
  DISABLED: 'disabled',
  EXPO: 'expo'
} as const;

export type NativePushMode = typeof NATIVE_PUSH_MODES[keyof typeof NATIVE_PUSH_MODES];

const NATIVE_PUSH_MODE_VALUES = new Set<string>(Object.values(NATIVE_PUSH_MODES));

/** Native push is an explicit self-host opt-in because Expo is an external delivery service. */
export function resolveNativePushMode(env: NodeJS.ProcessEnv = process.env): NativePushMode {
  return env.NATIVE_PUSH_MODE?.trim().toLowerCase() === NATIVE_PUSH_MODES.EXPO
    ? NATIVE_PUSH_MODES.EXPO
    : NATIVE_PUSH_MODES.DISABLED;
}

/** Return an actionable startup warning for an invalid opt-in value without exposing env contents. */
export function getNativePushModeConfigurationWarning(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.NATIVE_PUSH_MODE?.trim().toLowerCase();
  if (!configured || NATIVE_PUSH_MODE_VALUES.has(configured)) return null;
  return 'NATIVE_PUSH_MODE must be disabled or expo; native Android push is disabled until the value is corrected.';
}
