# Mobile Client

Expo React Native client for calibrate on Android and iOS.

The app tracks the latest stable Expo release and currently uses Expo SDK 58 with React Native 0.88 and React 19.3. Development
builds are the primary native workflow; Expo Go is useful for lightweight checks but is not the release runtime.

## Native Google and Apple sign-in

Google sign-in is available on Android and iOS; Apple sign-in uses the native iOS
authorization sheet. The [Firebase backend](../backend/README.md#native-provider-sign-in)
exchanges provider credentials and continues to issue Calibrate's rotating device
sessions. No Firebase client session or provider refresh token is stored on the device.
Browser email/password sign-in remains available.

Set `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` to the Firebase project's Google **Web** OAuth
client ID. Set `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` for the store iOS bundle and
`EXPO_PUBLIC_GOOGLE_IOS_DEVELOPMENT_CLIENT_ID` for the development bundle.
`app.config.js` selects the matching client, embeds it for the native SDK and derives
its reversed URL scheme. Supply these
public values consistently to native builds, Metro and EAS updates; client IDs are
public configuration, not secrets. Local native launch reads them from root `.env`.

Register Android package/signing-certificate combinations and iOS bundle IDs in the
same Firebase/Google project. Include both store and development application IDs,
local signing certificates and Play App Signing certificates as applicable. Enable
Sign in with Apple for each Apple App ID and regenerate provisioning profiles;
the Expo Apple plugin adds the entitlement. Register the iOS apps with Firebase and
enable Apple in Firebase Authentication. Apple private-relay email is accepted;
configure Apple's email relay for Firebase recovery mail if it is used.

These native dependencies require rebuilt development/store binaries. Expo Go and
existing binaries without the modules cannot exercise the flow. Follow the existing
major-runtime release policy when shipping the native compatibility change; this
feature does not change release numbers itself. The native welcome screen shows
Google and Apple beside the email entry points when the configured backend and
device support them. The buttons use the providers' native styles and share the
same width and touch height. The web welcome offers email sign-in and registration.

One provider action handles both returning users and new accounts. A returning
user receives a Calibrate session immediately after the verified provider exchange.
When the server requires registration, the app asks for confirmation and the
current hosted Terms and Privacy Policy before submitting the same credential.
That credential stays in memory and expires after five minutes or when the user
leaves the flow. New users continue through profile and goal onboarding.

Validate on signed Android and iOS builds: new registration, returning sign-in,
Google account selection after logout, Apple cancellation and repeat sign-in
(including hidden email), missing provider configuration, email collisions, and
session restore after app restart. Native provider sheets require real provider
accounts; unit tests use synthetic credentials.

## Development

Start the API/database with `npm run dev`; the
[development tools guide](../scripts/README.md#development) owns prerequisites,
worktree setup and seeded/manual authentication.

- `npm run dev:native -- --platform android` starts Metro for the separate Calibrate Dev app;
  use `--platform ios` for iOS Simulator. `dev:expo` remains an alias. Keep `npm run dev` running separately.
  Add `--port 8082 --host <LAN-IPv4> --clear` when selecting a Metro port and advertised host.
- For local build/install, set `EXPO_RELEASE_VARIANT=development` before running
  `npm --prefix mobile run android` or, on macOS, `npm --prefix mobile run ios`.
  Use the same public environment/native inputs as Metro or the hosted preview.
- Android emulators reach the host at `10.0.2.2`; iOS Simulator uses `127.0.0.1`.
- For Expo Go on a physical Android or iOS phone, start Expo with a LAN-reachable backend URL:
  Use an Expo Go build supporting SDK 58. Health Connect, Wear pairing, and remote push require a custom development build.
  `$env:EXPO_PUBLIC_CALIBRATE_SERVER_URL='http://<host-lan-ip>:<worktree-api-port>'; npm.cmd --prefix mobile run start -- --go --lan --clear`.
- In Expo dev builds pointed at localhost, the emulator loopback, or a LAN backend, the app auto-mints a mobile
  session for `test@calibratehealth.app` when no stored session can be restored.
- Official builds default to `https://calibratehealth.app`.
- Native uses the backend configured at build time; users cannot override it in the app.

`npm run preview -- --platform android` (or `ios`) publishes a hosted preview of the
working copy, including uncommitted edits, using EAS CLI 25.3.0 and an authenticated
Expo account. Open the returned dashboard link and scan its development-build QR code
with a compatible Calibrate Dev installation. Metro is not required. Each invocation
creates an isolated preview branch and leaves the development/beta/production channels
unchanged. `npm run preview:web` retains the local backend plus web-export preview.

The shared toolkit owns development names, schemes, separate application IDs and
fingerprint runtimes. `index.js` checks the installed native runtime before loading
Router in a development client, including minified hosted previews. A mismatch shows
rebuild/reopen instructions without importing app features. Restart Metro and reopen
the project through its development link after native changes; Fast Refresh does not
refresh the manifest. Web and release builds retain normal Router startup, and release
OTA continues using the shared mobile major. Final release-mode and Wear-pairing
validation belongs in beta. See [workflow setup](../.github/workflows/README.md#development-previews)
for hosted builds, EAS environment values and device registration.

Hosted Android development builds disable EAS's Maven cache injection with
`EAS_BUILD_DISABLE_MAVEN_CACHE=1`. Its injected Artifactory plugin adds dependencies
outside the reviewed Gradle verification metadata; direct repository downloads keep
the existing strict dependency verification intact.

## Architecture

- Auth uses `/auth/mobile/*` bearer-token endpoints and stores tokens in Expo SecureStore.
- The app consumes versioned `/api/v1/*` resources through `@calibrate/api-client`.
- Native push registration uses Expo push tokens via `/api/notifications/native-subscription`.
- Barcode scanning uses `expo-camera`; haptics use `expo-haptics`.
- `android/` and `ios/` are generated by Expo prebuild and are intentionally ignored.

## Validation

```sh
npm --prefix mobile run typecheck
npm --prefix mobile test
```

CI prebuilds and compiles both Android and iOS so native config drift is caught before release work.
The [local native workflow](../scripts/README.md#local-native-workflow) owns Android
tooling; the [Release workflow](../.github/workflows/README.md#release) owns protected
phone/Wear builds, signing, Play submission and major-runtime OTA. Wear changes
require a new package.

## Browser and module boundaries

The same route tree produces Web/PWA and native clients. Browser cookie auth,
IndexedDB queues and service workers use platform modules; Health Connect and Wear
native dependencies must not evaluate in a browser bundle. Production web is bound
to its serving origin. Native uses `EXPO_PUBLIC_CALIBRATE_SERVER_URL` from the build
and probes compatibility before sending credentials. Without an explicit value, release
builds use `https://calibratehealth.app`; development uses `http://10.0.2.2:3000` on
Android or `http://127.0.0.1:3000` on iOS unless the launcher supplies its worktree API.
Neither client exposes a server selector or accepts server overrides from auth links.
Native storage retains the last credential origin only to prevent restoring tokens on
a different backend. Legacy custom-server preferences do not change the configured
backend; credentials with a different or unknown origin are cleared before restoration.
Same-origin credentials and origin-scoped offline workspaces remain usable.

The production image serves `mobile/dist` through `FRONTEND_DIST_DIR`, preserving
API/auth routes. `npm run test:expo-web:release` validates export routes, PWA files
and hashed bundles; [browser tests](../e2e/expo-web/README.md) own interaction checks.
[PWA](src/pwa/README.md) owns installation, offline notices and browser update behavior.

## Module documentation

Start with [UI primitives](src/components/README.md), [Today](src/today/README.md),
[Progress](src/progress/README.md), [onboarding](src/onboarding/README.md),
[offline tracking](src/offline/README.md), [local-day hooks](src/hooks/README.md),
[Health Connect](src/healthConnect/README.md), [notifications](src/notifications/README.md),
and [PWA lifecycle](src/pwa/README.md).

## Hosted app links

The Android app declares verified links for `calibratehealth.app`. Serve
`/.well-known/assetlinks.json` as unauthenticated JSON over public HTTPS with no redirect,
using `net.darkmachines.healthtracker` and all supported installed-app certificate
SHA-256 fingerprints. A Play distribution key may differ from the upload key; inspect
the actual installed signer. Retire fingerprints only after their app versions retire.

iOS declares `applinks:calibratehealth.app`. Serve the extensionless
`/.well-known/apple-app-site-association` with the same response constraints and
`<production-team-id>.app.calibratehealth.mobile`. Use the real signing team, never a
placeholder. Associate only registered routes with browser fallbacks. Verification
and reset links use the same `PUBLIC_APP_ORIGIN`; test both signed-out browser fallback
and installed-device routing. Self-hosted domains are not automatically associated.
