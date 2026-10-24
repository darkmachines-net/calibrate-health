# Calibrate Wear OS

Standalone native Kotlin/Compose application for the Calibrate Wear OS companion. Keeping this project outside
`mobile/android/` prevents Expo prebuilds from rewriting watch code.

## Variants

- `debug`: debug-signed and defaults to the emulator host at `http://10.0.2.2:3000`; use
  `-PcalibrateWearDebugServerUrl=http://<LAN-IP>:3000` for a physical watch on a trusted private network.
- `internal`: uses shared release signing when all signing values are supplied, otherwise falls back to the phone debug key; defaults to the hosted server.
- `release`: release signing is supplied outside the repository.

Every variant uses `net.darkmachines.healthtracker`, matching the phone app. Wear Data Layer requires the installed
phone and watch artifacts to have both the same application ID and the same signing identity. Debug builds and
debug-fallback internal builds pair with a debug-signed phone build. A release-signed internal build pairs only with
a phone artifact signed by that same release identity. Production phone and watch artifacts must also use the same
release key. The variants are alternatives and cannot be installed side by side on one device.

Debug builds, and internal builds without release-signing values, use the exact debug keystore generated for the phone at
`mobile/android/app/debug.keystore`, with the standard `android` / `androiddebugkey` credentials. Generate it before
configuring the Wear build:

```powershell
npm --prefix mobile run prebuild:android
```

The Wear build fails with an actionable error when that file is missing instead of silently creating a different
certificate that cannot communicate through Data Layer.

Release builds require the following values as environment variables or Gradle properties. Never put their values in
tracked files:

- `CALIBRATE_ANDROID_SIGNING_STORE_FILE`: absolute path, or path relative to the repository root
- `CALIBRATE_ANDROID_SIGNING_STORE_PASSWORD`
- `CALIBRATE_ANDROID_SIGNING_KEY_ALIAS`
- `CALIBRATE_ANDROID_SIGNING_KEY_PASSWORD`

All four values are required together. The phone's persisted Expo config plugin consumes the same values and refuses
release work when they are absent. Matching the application ID is not sufficient - Data Layer release discovery also
requires matching signing certificates.

Internal and release builds can bootstrap a self-hosted origin with Gradle properties. The origin is validated and
baked into `BuildConfig`; there is no runtime settings override that can silently retarget the watch. Do not put
credentials or tokens in this value because `BuildConfig` values are readable from the artifact.

```powershell
.\gradlew.bat :app:assembleInternal `
  -PcalibrateWearServerUrl=https://health.example.com

# Allow HTTP only for an explicitly trusted development network.
.\gradlew.bat :app:assembleInternal `
  -PcalibrateWearServerUrl=http://192.168.1.10:3000 `
  -PcalibrateWearAllowCleartext=true
```

HTTPS origins are accepted for any host. HTTP requires `calibrateWearAllowCleartext=true` and a literal loopback,
private IPv4/private IPv6 address, or `.local` host. Public HTTP, credentials, paths, queries, and fragments are
rejected during Gradle configuration. When the configured origin is HTTPS, cleartext traffic remains disabled even
if the allow flag was supplied.

For a same-signed physical debug build, point the watch directly at the development server's private-LAN address:

```powershell
.\gradlew.bat :app:assembleDebug `
  -PcalibrateWearDebugServerUrl=http://192.168.1.10:3000
```

The debug override accepts the same literal loopback/private-address rules while keeping the emulator default when
the property is omitted. The phone and watch must still be signed by the same debug key.

## Validate

```powershell
$env:JAVA_HOME='C:\Program Files\Android\Android Studio\jbr'
$env:ANDROID_HOME="$env:LOCALAPPDATA\Android\Sdk"
.\gradlew.bat :app:testDebugUnitTest :app:assembleDebug :app:assembleInternal --console=plain
.\gradlew.bat :app:testWearServerOriginValidation --console=plain
```

The runtime derives unpaired, pairing, recovery, and paired states from durable storage; deterministic health values
remain limited to tests. The glance-first home emphasizes consumed and remaining calories plus goal progress, while
quick add, undo, rotary weight entry, continue-on-phone, and connection controls live on a secondary Actions screen.
The cache-only Tile and calorie-balance complication expose calorie progress and cache freshness without initiating
network work from their system-rendered services.

`WearDataLayerContract` defines versioned paths for pairing, sync invalidation, continue-on-phone
handoffs, and bounded authenticated HTTP relay through the paired phone. The transport tries that relay first,
then falls back to a direct server connection when the phone transport is unavailable. The watch caches its own
data with Room. Sync invalidations contain only bounded server/account/device metadata, are accepted
only from the exact phone node stored during pairing, and schedule the same constrained WorkManager refresh chain.

The watch publishes the `calibrate_wear_pairing_v1` capability through `android_wear_capabilities`. This capability is
only for phone-side discovery; the separate relay paths carry allowlisted Watch API requests and responses.

After server-confirmed account deletion, the phone sends a short-lived, account-bound disconnect command to the exact
paired node before erasing its own pairing metadata. The watch accepts it only from the retained phone node with an
exact server, user, and watch-device match, then runs the same credential, cache, outbox, reminder, and pairing cleanup
as watch-local disconnect. If the watch is unreachable during deletion, phone data is still cleared; disconnect from
the watch UI before pairing or signing in again.

## Offline storage and outbox

Room stores four deliberately small data sets:

- Up to 21 daily summary snapshots, newest local date first.
- A replacement snapshot of up to 24 ranked quick-add items with immutable mutation payloads; missing server IDs are
  removed on refresh.
- Pending mutations and up to 100 terminal operation tombstones for idempotency and diagnostics.
- One sync metadata row containing the selected origin, cursor, invalidation time, and protocol version.

Queued mutations receive a UUID operation ID once, before persistence. A single unique WorkManager chain drains the
database head-first with a connected-network constraint and WorkManager's capped exponential backoff. A retry leaves
the head in place, so later writes cannot overtake it after a process restart. Healthy batches schedule an immediate
continuation instead of being mislabeled as failures. The worker rebuilds its Room, secure-session, and authenticated
HTTP dependencies in every process. Conditional snapshot refreshes and mutation responses are committed only if the
captured account scope is still current, preventing a re-pair race from crossing account data.

Pairing credentials are not stored in Room. `AndroidKeystoreTokenStore` encrypts the session with an Android
Keystore-backed AES-256-GCM key and stores access/refresh tokens only inside the authenticated ciphertext envelope in
private preferences. The app has backups disabled so an encrypted blob cannot be restored without its non-exportable
key. A stored credential must match the build-configured, validated server origin exactly. Changing accounts clears
all account-scoped Room data before the replacement credential becomes visible; same-account token rotation retains
the cache and outbox.

Tiles and UI surfaces must read cached repositories. They must not call the server directly; WorkManager is the only
background outbox entry point.

## Reminder delivery and disconnected behavior

The self-hosted server remains authoritative for reminder preferences, local-day eligibility, and deduplication. The
restricted Watch snapshot includes at most one active food reminder and one active weight reminder for the current
local day. The watch combines those rows into one local notification with an allowlisted food-summary or weight-entry
deep link; it never accepts arbitrary notification copy or URLs from the server.

To avoid competing with Android's normal phone-to-watch notification bridging, the watch cancels its local reminder
whenever a paired phone node is reachable. A paired watch with its own Wi-Fi or LTE connection performs a
battery-not-low, network-constrained refresh approximately hourly. It may post the local reminder only when phone
reachability is known to be absent. If the Data Layer reachability check fails, the watch fails closed and does not
post a potentially duplicate notification.

When both phone and watch are disconnected from every network, no new reminder can be delivered. The server's phone
push remains the primary reminder and will follow the phone provider's normal retry behavior; the watch does not
invent a reminder from stale calories or weight data. After the standalone watch regains network access, its next
bounded refresh can obtain the current unresolved reminder. Completing the food or weight action resolves the server
reminder; a later snapshot removes and cancels the watch-local notification.

On Android 13 / Wear OS 4 and later, local watch reminders require the watch app's notification permission. Denying
permission does not affect tracking, synchronization, or phone reminders, and the same server reminder remains
eligible if permission is granted later.

## Deferred sensors

The initial companion does not request continuous heart-rate, body-sensor, or workout permissions. Galaxy Watch
activity reaches Calibrate through Samsung Health and the phone's Health Connect sync. A future Calibrate-owned
workout feature would use Health Services `ExerciseClient` only after defining a concrete workout UX, sampling and
battery budget, retention policy, and privacy value that justifies collecting sensor data directly on the watch.

The optional calorie-balance complication supports short-text and ranged-value watch-face slots. It is limited to a
concise remaining/over value and consumed-target progress, reads only the account-scoped Room cache, opens Calibrate
when tapped, and requests a system refresh after the same cache transitions that invalidate the Tile. It never
includes food names or weight values and never initiates network work.

Fast JVM contract tests cover cache bounds, FIFO ordering, stable IDs, retry behavior, and fake-store recreation.
On-device instrumentation tests close and reopen the real Room database and Keystore token store to verify durable
state across object/process recreation.

Room schema snapshots live in `app/schemas/`. When changing the database, generate the next schema through a real
Gradle build and verify its migration against the existing snapshots; do not hand-author its identity hash.
