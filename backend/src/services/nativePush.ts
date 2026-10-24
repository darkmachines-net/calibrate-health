/** @file Configured native push delivery with bounded payloads and provider error handling. */

import { NativePushProvider } from '@prisma/client';
import { type PushNotificationPayload } from './pushNotificationPayloads';

const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';

export type NativePushSubscriptionForDelivery = {
  id: number;
  provider: NativePushProvider;
  token: string;
};

type ExpoPushError = Error & {
  statusCode?: number;
};

const buildExpoPayload = (token: string, payload: PushNotificationPayload) => ({
  to: token,
  title: payload.title,
  body: payload.body,
  sound: 'default',
  data: {
    url: payload.url ?? '/',
    tag: payload.tag,
    actionUrls: payload.actionUrls
  }
});

const buildExpoError = (message: string, statusCode?: number): ExpoPushError => {
  const error = new Error(message) as ExpoPushError;
  error.statusCode = statusCode;
  return error;
};

/**
 * Send a notification through the configured native provider.
 *
 * Expo tokens are supported first because Expo development builds are the native-client baseline.
 */
export async function sendNativePushNotification(
  subscription: NativePushSubscriptionForDelivery,
  payload: PushNotificationPayload
): Promise<void> {
  if (subscription.provider !== NativePushProvider.EXPO) {
    throw buildExpoError(`Native push provider ${subscription.provider} is not implemented.`);
  }

  const response = await fetch(EXPO_PUSH_ENDPOINT, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json'
    },
    body: JSON.stringify(buildExpoPayload(subscription.token, payload))
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw buildExpoError(`Expo push request failed with HTTP ${response.status}.`, response.status);
  }

  const ticket = body?.data;
  if (ticket?.status === 'error') {
    const detailsError = ticket.details?.error;
    const statusCode = detailsError === 'DeviceNotRegistered' ? 410 : undefined;
    throw buildExpoError(ticket.message ?? 'Expo push delivery failed.', statusCode);
  }
}
