# Browser installation and updates

The production Expo export is installable on desktop and mobile browsers. The
production image serves it from the same origin as the API. Build with
`npm run build:expo-web`, then use `npm --prefix mobile run preview:web` and open
`http://localhost:4174` to inspect the release artifact and browser installation UI.

[runtime.web.ts](runtime.web.ts) owns the browser service-worker lifecycle exposed
to React. Use the external-store subscription rather than copying worker state
into effect-driven component state. Offline, reconnected, update-ready and
update-failed notices offer meaningful actions; do not announce successful
background cache preparation as a user-facing event.

The worker source is `mobile/public/sw.js`; `scripts/expo-web-release.mjs` binds
its cache manifest to the exported assets. Never hand-edit built output. Run
`npm run test:expo-web:release` and the relevant browser tests after lifecycle changes.
[Notification clients](../notifications/README.md) own push registration and delivery.
