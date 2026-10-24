# Reminder clients

Server in-app records are authoritative. The bell shows active reminders and a global
unread count; Settings owns schedules and permission recovery. SSE, polling and
service-worker messages invalidate/refetch that state instead of becoming separate stores.
Deep links accept only registered destinations.

Native registration requires both a signed-in user action and the server's capability.
`NATIVE_PUSH_MODE` defaults to disabled; `expo` opts into the Expo Push Service
boundary. Disabled servers reject registration and delivery, and the phone does not
request permission. Web push separately requires operator VAPID configuration.
Direct FCM is not implemented. Missing delivery configuration does not suppress the
canonical in-app reminder.

Background phone reminders are not guaranteed with native push disabled: there is no
phone-local scheduling fallback. The watch can suppress its local reminder while the
phone is reachable. See [Wear](../../../wear/README.md#reminder-delivery-and-disconnected-behavior)
for its coordination policy. Dedupe belongs to the synchronized account/reminder/local
day identity, not to a transport attempt. Test denied/revoked permissions, reconnect,
account changes and allowlisted links when editing these clients.

## Browser push configuration

Browser registration and delivery require `WEB_PUSH_PUBLIC_KEY`,
`WEB_PUSH_PRIVATE_KEY`, and `WEB_PUSH_SUBJECT` on the backend. The development
launcher generates missing VAPID values in `.dev.env`; root `.env` overrides
them. Direct backend execution must supply them explicitly. See the root and
backend `.env.example` files for configuration names.
