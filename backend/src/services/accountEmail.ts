/** @file Verification and recovery email composition, configured transport reuse, and delivery errors. */

import {
  EMAIL_DELIVERY_MODES,
  resolveEmailDeliveryConfig,
  type EmailDeliveryConfig
} from '../config/emailDelivery';

type Transporter = {
  sendMail(options: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
};
const nodemailer = require('nodemailer') as {
  createTransport(options: {
    host: string;
    port: number;
    secure: boolean;
    auth?: { user: string; pass: string };
  }): Transporter;
};

export type AccountEmailKind = 'email_verification' | 'password_reset';

type AccountEmail = {
  kind: AccountEmailKind;
  recipient: string;
  token: string;
};

let cachedConfig: Extract<EmailDeliveryConfig, { mode: 'smtp' }> | null = null;
let cachedTransport: Transporter | null = null;

/** Compare transport-defining fields because the default resolver returns a fresh object for every send. */
function matchesCachedSmtpConfig(
  current: Extract<EmailDeliveryConfig, { mode: 'smtp' }>,
  candidate: Extract<EmailDeliveryConfig, { mode: 'smtp' }>
): boolean {
  return current.host === candidate.host
    && current.port === candidate.port
    && current.secure === candidate.secure
    && current.username === candidate.username
    && current.password === candidate.password
    && current.from === candidate.from
    && current.publicAppOrigin === candidate.publicAppOrigin;
}

const transportFor = (config: Extract<EmailDeliveryConfig, { mode: 'smtp' }>): Transporter => {
  if (cachedConfig && cachedTransport && matchesCachedSmtpConfig(cachedConfig, config)) return cachedTransport;
  cachedConfig = config;
  cachedTransport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.username && config.password
      ? { user: config.username, pass: config.password }
      : undefined
  });
  return cachedTransport;
};

/** Create verification/reset text using the configured public origin and a fragment token that avoids URL-query logging. */
export const buildAccountEmailMessage = (
  email: AccountEmail,
  config: Extract<EmailDeliveryConfig, { mode: 'smtp' }>
): { subject: string; text: string } => {
  const route = email.kind === 'email_verification' ? '/verify-email' : '/reset-password';
  const link = `${config.publicAppOrigin}${route}#token=${encodeURIComponent(email.token)}`;
  if (email.kind === 'email_verification') {
    return {
      subject: 'Verify your Calibrate email',
      text: `Verify your Calibrate email by opening this link within 24 hours:\n\n${link}\n\nIf you did not create this account, you can ignore this message.`
    };
  }
  return {
    subject: 'Reset your Calibrate password',
    text: `Reset your Calibrate password by opening this link within 30 minutes:\n\n${link}\n\nIf you did not request a reset, you can ignore this message.`
  };
};

/** Deliver a one-time account link. Callers receive only success/failure; secrets are never logged. */
export async function deliverAccountEmail(
  email: AccountEmail,
  config = resolveEmailDeliveryConfig()
): Promise<boolean> {
  if (config.mode !== EMAIL_DELIVERY_MODES.SMTP) return false;
  const message = buildAccountEmailMessage(email, config);
  try {
    await transportFor(config).sendMail({
      from: config.from,
      to: email.recipient,
      subject: message.subject,
      text: message.text
    });
    return true;
  } catch {
    return false;
  }
}

/** Test hook that prevents transports/configuration from leaking between isolated cases. */
export function resetAccountEmailTransportForTests(): void {
  cachedConfig = null;
  cachedTransport = null;
}
