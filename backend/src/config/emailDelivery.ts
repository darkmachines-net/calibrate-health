/** @file Environment-based email delivery configuration and hosted-service policy. */

import { CALIBRATE_HOSTED_ORIGIN } from '../../../shared/product';
import { isProductionOrStagingEnv } from './environment';

export const EMAIL_DELIVERY_MODES = {
  DISABLED: 'disabled',
  SMTP: 'smtp'
} as const;

export type EmailDeliveryConfig =
  | {
      mode: 'disabled';
      hostedRequired: boolean;
      publicAppOrigin: string | null;
    }
  | {
      mode: 'smtp';
      hostedRequired: boolean;
      publicAppOrigin: string;
      host: string;
      port: number;
      secure: boolean;
      username: string | null;
      password: string | null;
      from: string;
    };

const normalizeOrigin = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
};

const parsePort = (value: string | undefined): number | null => {
  if (!value?.trim()) return 587;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : null;
};

/** The official hosted service owns email delivery and legal-consent policy. */
export const isHostedServiceDeployment = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.CALIBRATE_HOSTED_SERVICE?.trim().toLowerCase() === 'true' &&
  isProductionOrStagingEnv(env.NODE_ENV);

/** Resolve provider-neutral SMTP configuration without exposing any credentials. */
export function resolveEmailDeliveryConfig(env: NodeJS.ProcessEnv = process.env): EmailDeliveryConfig {
  const hostedRequired = isHostedServiceDeployment(env);
  const publicAppOrigin = normalizeOrigin(env.PUBLIC_APP_ORIGIN) ??
    (hostedRequired ? CALIBRATE_HOSTED_ORIGIN : null);
  const mode = env.EMAIL_DELIVERY_MODE?.trim().toLowerCase() ?? EMAIL_DELIVERY_MODES.DISABLED;

  if (mode !== EMAIL_DELIVERY_MODES.SMTP) {
    return { mode: EMAIL_DELIVERY_MODES.DISABLED, hostedRequired, publicAppOrigin };
  }

  const host = env.SMTP_HOST?.trim() ?? '';
  const from = env.SMTP_FROM?.trim() ?? '';
  const port = parsePort(env.SMTP_PORT);
  const username = env.SMTP_USERNAME?.trim() || null;
  const password = env.SMTP_PASSWORD?.trim() || null;
  const credentialsComplete = Boolean(username) === Boolean(password);
  const hostedOriginIsSecure = !hostedRequired || publicAppOrigin?.startsWith('https://') === true;
  if (!host || !from || !port || !publicAppOrigin || !credentialsComplete || !hostedOriginIsSecure) {
    return { mode: EMAIL_DELIVERY_MODES.DISABLED, hostedRequired, publicAppOrigin };
  }

  return {
    mode: EMAIL_DELIVERY_MODES.SMTP,
    hostedRequired,
    publicAppOrigin,
    host,
    port,
    secure: env.SMTP_SECURE?.trim().toLowerCase() === 'true',
    username,
    password,
    from
  };
}

/** Require verification for hosted accounts or any instance with SMTP delivery enabled. */
export const isEmailVerificationRequired = (config: EmailDeliveryConfig): boolean =>
  config.hostedRequired || config.mode === EMAIL_DELIVERY_MODES.SMTP;
