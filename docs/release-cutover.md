# Fresh major-runtime cutover

Merge the toolkit first, then this consumer at the same immutable SHA. Do not dispatch a release during PR validation. No old plans, receipts, pending requests or runtime baselines are imported. Both consumers require a new native installation before receiving subsequent OTA updates.

The committed semantic floors are server 0.40.3 and mobile 0.2.9. The owner confirmed Play's highest phone/watch version codes as 11/12 on 2026-10-23 (Pacific). Current repository metadata already records phone 17 and watch 18, so retain paired floor 18 and reserve 19/20 next; do not lower the floor to Play's older values. Read-only EAS history contains only a canceled 0.2.3/code 5 build and is not the source of the Play confirmation. Preserve the existing phone/Wear signing key. Assign the existing Play submission credential to the phone and wear EAS submit profiles; do not create replacement signing identities.

Keep existing application/project IDs, channels, webhook destinations, WireGuard peer and protected environments. Standard workflow signing secret names are ANDROID_KEYSTORE_BASE64, ANDROID_STORE_PASSWORD, ANDROID_KEY_ALIAS and ANDROID_KEY_PASSWORD; ordinary EAS builds use their managed credentials. Expo operations use EXPO_TOKEN. WireGuard variables and secrets retain their existing DEPLOY_* names.

Confirm public EAS inputs are declared readable strings. Create protected environment gates before allowing workflow dispatch. A human performs the first release and verifies real native installation, store handoff and server health. This PR does not perform those live actions.
