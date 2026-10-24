/** @file VAPID configuration, browser push subscription lifecycle, and bounded delivery handling. */

import webpush, { type PushSubscription } from 'web-push';

type WebPushConfig = {
  publicKey: string;
  privateKey: string;
  subject: string;
};

type WebPushConfigResult = {
  config: WebPushConfig | null;
  error?: string;
};

/**
 * Resolve VAPID configuration from the environment with actionable error messaging.
 */
export function resolveWebPushConfig(env: NodeJS.ProcessEnv = process.env): WebPushConfigResult {
  const publicKey = env.WEB_PUSH_PUBLIC_KEY?.trim();
  const privateKey = env.WEB_PUSH_PRIVATE_KEY?.trim();
  const subject = env.WEB_PUSH_SUBJECT?.trim();

  const missing: string[] = [];
  if (!publicKey) missing.push('WEB_PUSH_PUBLIC_KEY');
  if (!privateKey) missing.push('WEB_PUSH_PRIVATE_KEY');
  if (!subject) missing.push('WEB_PUSH_SUBJECT');

  if (!publicKey || !privateKey || !subject) {
    return {
      config: null,
      error: `Web push is disabled: missing ${missing.join(
        ', '
      )}. Set these environment variables to enable push notifications.`
    };
  }

  return {
    config: {
      publicKey,
      privateKey,
      subject
    }
  };
}

/**
 * Ensure web-push has been configured with VAPID details before sending.
 */
export function ensureWebPushConfigured(env: NodeJS.ProcessEnv = process.env): { ok: boolean; error?: string } {
  const { config, error } = resolveWebPushConfig(env);
  if (!config) {
    return { ok: false, error };
  }

  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  return { ok: true };
}

/**
 * Return the public VAPID key for frontend subscription registration.
 */
export function getWebPushPublicKey(env: NodeJS.ProcessEnv = process.env): { publicKey: string | null; error?: string } {
  const { config, error } = resolveWebPushConfig(env);
  return { publicKey: config?.publicKey ?? null, error };
}

/**
 * Send a push payload to a stored subscription.
 */
export async function sendWebPushNotification(
  subscription: PushSubscription,
  payload: string
): Promise<webpush.SendResult> {
  const configured = ensureWebPushConfigured();
  if (!configured.ok) {
    throw new Error(configured.error ?? 'Web push configuration is missing.');
  }

  return webpush.sendNotification(subscription, payload);
}
