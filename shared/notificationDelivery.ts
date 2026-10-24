/** @file Validated notification channel selection and shared delivery result contracts. */

export const NOTIFICATION_DELIVERY_CHANNELS = {
    PUSH: 'push',
    IN_APP: 'in_app'
} as const;

export type NotificationDeliveryChannel =
    (typeof NOTIFICATION_DELIVERY_CHANNELS)[keyof typeof NOTIFICATION_DELIVERY_CHANNELS];

export const DEFAULT_NOTIFICATION_DELIVERY_CHANNELS: readonly NotificationDeliveryChannel[] = [
    NOTIFICATION_DELIVERY_CHANNELS.PUSH,
    NOTIFICATION_DELIVERY_CHANNELS.IN_APP
] as const;

const DELIVERY_CHANNEL_VALUES = new Set<string>(Object.values(NOTIFICATION_DELIVERY_CHANNELS));

/**
 * Return validated delivery channels from arbitrary input while preserving request order.
 */
export const parseNotificationDeliveryChannels = (value: unknown): NotificationDeliveryChannel[] => {
    if (!Array.isArray(value)) {
        return [];
    }

    const channels: NotificationDeliveryChannel[] = [];
    for (const candidate of value) {
        if (typeof candidate !== 'string') {
            continue;
        }

        const normalized = candidate.trim();
        if (!DELIVERY_CHANNEL_VALUES.has(normalized)) {
            continue;
        }

        const channel = normalized as NotificationDeliveryChannel;
        if (!channels.includes(channel)) {
            channels.push(channel);
        }
    }

    return channels;
};

/**
 * Parse channels with a fallback when no valid channel values are provided.
 */
export const resolveNotificationDeliveryChannels = (
    value: unknown,
    fallback: readonly NotificationDeliveryChannel[] = DEFAULT_NOTIFICATION_DELIVERY_CHANNELS
): NotificationDeliveryChannel[] => {
    const parsed = parseNotificationDeliveryChannels(value);
    return parsed.length > 0 ? parsed : [...fallback];
};
