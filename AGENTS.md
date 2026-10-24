# calibrate Agent Guide

This file is for AI/code agents working in this repo. Keep changes aligned with
the product shape, current architecture, and the workflow conventions that have
already been validated here.

## Product Contract

calibrate is a responsive calorie tracker for desktop and mobile web. Users log
food and weight, then compare daily calorie intake with an estimated target from
their profile and goal.

Core requirements:

- Multi-user email/password auth with cookie sessions.
- Required profile data for calorie math: date of birth or age, sex, height,
  current weight, timezone, unit preference, language, and activity level.
- Goal setup with start weight, target weight, and signed `daily_deficit`.
- Allowed daily deficit/surplus magnitudes are defined in `shared/goalDeficit.ts`
  and must remain `0`, `250`, `500`, `750`, `1000` kcal/day.
- Positive `daily_deficit` means deficit/weight loss. Negative means surplus/
  weight gain. `0` means maintenance.
- Food logging is organized by fixed meal periods: Breakfast, Morning Snack,
  Lunch, Afternoon Snack, Dinner, Evening Snack.
- Weight and food "day" grouping must follow the user's IANA timezone, not the
  server timezone.
- Visualization should support calories consumed vs target, weight trend, and
  steady-rate goal projection. Maintenance goals do not show a projection date.

Calorie math:

- BMR uses Mifflin-St Jeor.
- TDEE is `BMR * activityMultiplier`.
- Baseline daily target is `TDEE - daily_deficit`.
- A user-approved calibration revision may add a bounded target correction while
  leaving the configured deficit and profile-estimated TDEE unchanged.
- Projection uses a constant rate of `3500 kcal/lb` or `7700 kcal/kg`.
- "Calories out" remains the profile-estimated TDEE. Weight and intake trends
  may support a bounded calorie-target correction, but must not replace or be
  displayed as the user's TDEE.

Non-goals for MVP:

- No activity-driven automatic calorie-target adjustment.
- No smart deficit adjustment to hit a target date.
- No advanced body composition modeling beyond optional stored fields.

## Architecture Map

- Client: Expo Router + React Native + React Native Web, TypeScript, React Query.
- Backend: Node.js + TypeScript + Express.
- Persistence: Postgres through Prisma under `backend/prisma/`.
- Shared domain constants live under `shared/`.
- Browser and native routes live under `mobile/app/`; shared client code lives
  under `mobile/src/`.
- Supported server-side language values live in `backend/src/utils/language.ts`.
- Food providers live in `backend/src/services/foodData/`.
- Self-hosting uses `deploy/` and expects an external Postgres unless a deployer
  explicitly adds one.

## Agent Operating Defaults

- Read the relevant code before proposing changes. Prefer existing patterns over
  new abstractions.
- If the user asks for a fix, upgrade, rebase, issue update, audit pass, or UI
  overhaul, implement it directly when feasible.
- Keep repo-owned workflows first. Prefer tracked scripts, Codex actions, and
  documented commands over one-off local instructions.
- Preserve disposable worktree and Codex app workflows. Do not steer back to
  static worktrees or CLI-only operation unless the app workflow is blocked.
- Treat Windows-host execution as a first-class path. Host-side scripts should
  use Node entrypoints rather than shell assumptions when practical.
- When diagnosing setup failures, start from the exact failing command/log and
  verify the repo-owned setup path before changing app code.
- Keep secrets out of the database. Provider API keys and client IDs are sourced
  from environment variables unless the product direction changes explicitly.
- Keep Codex and validation commands on the host. Use the repo-owned Compose
  launcher for the live application stack; do not add container-shell wrappers
  for ordinary tests, linting, builds, or Prisma work.

## Local Development

Primary workflows:

- Codex setup: `node .codex/local-environment.setup.mjs`
- Host dependency setup: `npm run setup`
- Windows Android build setup: `npm run native:setup` (add `-- --check` for a read-only prerequisite check)
- Prepare the worktree stack: `npm run dev:setup`
- Local dev server: `npm run dev`
- Native Expo dev-client bundler: `npm run dev:expo` (with the Compose stack
  running separately)
- Local dev without seeded-user auto-login: `npm run dev:manual-auth`
- Inspect the current stack: `npm run dev:status`
- Reset test-user onboarding: `npm run dev:reset-test-user-onboarding`
- Local CI equivalent: `npm run ci:local`

Worktree stack notes:

- `scripts/dev-stack.mjs` owns Docker/Compose lifecycle, stable ports, and the
  current worktree database. It always targets the current checkout.
- `scripts/dev-env.mjs` owns host dependency setup, Prisma commands, and local
  CI. Host dependency caches are lockfile-and-runtime based; keep cache-hit and
  cache-miss output explicit when editing setup.
- `compose.dev.yaml` runs separate `web`, `backend`, and `postgres` services.
  Compose Watch syncs source changes; package-lock and Prisma changes rebuild
  the affected image.
- Codex setup installs host dependencies and allocates `.dev.env`, but it does
  not start containers. This prevents idle stacks in code-only worktrees.
- `npm run dev:down` retains the current database volume. `npm run dev:reset`
  resets only that worktree's database.
- Repo root `.env` is gitignored. Do not assume it propagates to new worktrees
  unless setup copies it or the user sets machine/user environment variables.

Environment conventions:

- Root `.env` stores user-provided application credentials.
- `.dev.env` is generated, gitignored, worktree-specific, and contains only the
  allowlisted application configuration plus local ports/secrets.
- Direct backend package runs may use `backend/.env`; standard root database
  commands inject the current worktree database automatically.
- The seeded account is `test@calibratehealth.app`.
- `AUTO_LOGIN_TEST_USER=true` enables local auto-login for that seeded account.

## Validation

Choose validation proportional to the change, and report what ran.

Common checks:

- Full local CI: `npm run ci:local`
- ESLint (zero warnings) and all TypeScript surfaces: `npm run lint`
- ESLint only: `npm run lint:eslint`
- All TypeScript surfaces only: `npm run typecheck`
- Backend type-check: `npm --prefix backend run typecheck`
- Shared API client type-check: `npm --prefix packages/api-client run typecheck`
- Expo client type-check: `npm --prefix mobile run typecheck`
- Expo web build: `npm run build:expo-web`
- Expo client tests: `npm --prefix mobile test`
- Expo web release checks: `npm run test:expo-web:release`
- Backend tests: `npm --prefix backend test`
- Backend build: `npm --prefix backend run build`
- Audit from the root/mobile dependency context: `npm audit`
- Diff hygiene: `git diff --check`

Windows-specific note:

- Use `npm.cmd --prefix mobile run typecheck`, `npm.cmd --prefix mobile test --
  --runInBand`, and `npm.cmd --prefix mobile run build:web` when an issue or
  reviewer calls for the Windows-host Expo gates.

Client dependency/audit fixes:

- Keep remediation narrow. Prefer lockfile-only or targeted override fixes when
  they address the advisory.
- After lockfile-only work, run a full install if `eslint`, `tsc`, or other local
  binaries are missing before trusting lint/build results.

## Data And Domain Rules

- Store weights in grams and heights in millimeters; convert at API/UI edges.
- Store `FoodLog.local_date`, `FoodLogDay.local_date`, `BodyMetric.date`, and
  notification local dates as date-only values derived from `User.timezone`.
- Use shared timezone helpers for local-day calculations. Avoid duplicating date
  math or relying on server-local time.
- Food logs are immutable snapshots. My Foods and recipe edits must not
  retroactively mutate existing `FoodLog` entries.
- Preserve external provider and serving snapshot fields when editing food logs.
- Keep FatSecret attribution intact in client search/barcode results. The Expo
  barcode path is implemented through `mobile/src/barcode/workflow.ts`.
- Profile photos are stored inline as small processed avatars; respect
  `backend/src/utils/profileImage.ts` caps and parsing rules.
- Prisma migrations use ordinal folder names such as `0001_init`. If
  `prisma migrate dev` creates timestamped local folders, rename them to the
  ordinal style before sharing if they are still unapplied elsewhere.

Food provider behavior:

- `FOOD_DATA_PROVIDER` selects the preferred provider: `fatsecret`, `usda`, or
  `openfoodfacts`.
- FatSecret requires `FATSECRET_CLIENT_ID` and `FATSECRET_CLIENT_SECRET`.
- USDA requires `USDA_API_KEY`, though local development may use USDA `DEMO_KEY` for
  local fallback when no provider credentials exist.
- Missing credentials should not crash normal dev search. Detect available
  providers and use deterministic fallback order with the configured/default
  provider first.
- Keep provider identity stable across paginated text-search results. Do not
  switch providers on later empty pages if the client is appending results
  under first-page provider metadata.
- Do not merge provider results unless explicitly requested; the validated shape
  is sequential fallback.

## Expo Client Practices

- Keep browser and native behavior in the shared Expo source tree. Use matching
  `.web` and `.native` modules or the contracts under `mobile/src/platform/`
  when behavior must differ by runtime.
- Keep primary Expo Router navigation fast. Treat route splitting and deferred
  bundles as release behavior that requires browser and device validation.
- Preserve the app-like PWA experience. PWA toasts should be actionable: offline,
  back-online, update-ready, and update-failed are appropriate; lifecycle-only
  "ready for offline launch" messaging is not.
- Runtime PWA state should use React-safe external-store patterns such as
  `useSyncExternalStore` rather than setting component state from service-worker
  effects.
- Installed-app polish belongs in the Expo app shell. `mobile/app/_layout.tsx`,
  `mobile/app/_layout.web.tsx`, and `mobile/app/(tabs)/_layout.tsx` own global
  providers, browser shell behavior, and tab navigation.
- Keep mobile navigation focused. Do not reintroduce redundant profile/"More"
  bottom-nav entry points when top app-bar/account-menu access is sufficient.
- For public/auth/onboarding/account surfaces, keep one cohesive layout language
  across adjacent pages instead of polishing one page in isolation.
- Reuse the auth primitives under `mobile/src/components/auth/` for
  login/register shell work.
- Use `mobile/src/components/AppCard.tsx` and existing screen/card primitives
  only for intentional containment. Ordinary content uses `AppSection`, navigation uses
  `AppActionRow`, and consequential notices use `AppNotice`. Follow `docs/visual-design.md`
  for page widths, section rhythm, action hierarchy, and visual acceptance.
- Keep generic primitives under `mobile/src/components/`; put feature-specific
  behavior in the corresponding `mobile/src/` feature folder.
- Keep public privacy and account-deletion copy centralized in
  `mobile/src/legal/publicLegalContent.ts`.
- Prefer ASCII punctuation in UI strings (`|`, `-`, `...`) over bullets,
  ellipses, or curly punctuation.

UI code style:

- Avoid magic numbers for layout/styling. Prefer named constants, theme tokens,
  or wrapper presets.
- Add a short comment to new layout/motion constants explaining what they
  control.
- Keep JSX readable. Move heavy `sx` logic, one-of-N render branches, and state
  to label/variant mappings into named variables or helpers.
- Avoid nested ternaries. Use `if`/`switch` when mapping state to UI text,
  variants, or render branches.
- Use shared constants/enums for domain string unions used in comparisons or
  `<Select />` values.
- Deduplicate repeated enum-to-label/icon/color mappings into shared utilities
  when reused.
- Prefer shaped loading placeholders that keep stable UI chrome rendered.
- Encapsulate animation math/state in small helpers or hooks and respect
  `prefers-reduced-motion`.
- Remove unused wrapper props/types rather than carrying speculative API
  surface.

## Backend/API Practices

- Prefer explicit request parsing and response serialization helpers with typed
  wire shapes, especially around Date fields.
- Preserve Prisma datasource query parameters such as `schema` when refactoring
  database URL or `DB_*` connection plumbing.
- Use explicit environment helper names, such as production or staging, instead
  of ambiguous terms like production-like.
- When deployed and local-dev behavior intentionally differ, include a concise
  why comment.
- Make warnings actionable: include the consequence and the next env var or
  config step.
- Avoid duplicated time constants. Prefer shared exported duration constants for
  common day/week/session TTL math.
- When changing indexes or schema shape, inspect route/service query patterns
  first and model/index for those actual access paths.
- Close both Prisma and adapter-owned `pg.Pool` connections in scripts/tests
  that need deterministic shutdown.

## Release Versioning

- Ordinary feature and fix PRs must not change `shared/release.json` `server.version` or its package, lockfile,
  diagnostic, OpenAPI, and generated-client mirrors.
- After the desired changes land on `master`, run **Cut release** in GitHub Actions and choose `patch`, `minor`, or
  `major`. The action owns the synchronized release commit, version-only PR, tag, and GHCR publication.
- The visible server release Actions are read-only request workflows. Default-branch `workflow_run` handlers verify
  exact requests before calling reusable workers. Keep build and verification jobs read-only. Use job-scoped
  `GITHUB_TOKEN` writes only for candidate/tag publication, PR finalization/cleanup, and GHCR publication; callers must
  propagate every required reusable-workflow permission. Cut release calls existing read-only CI on the exact candidate
  and source SHAs; finalization verifies those jobs in the same trusted run, then uses the PR merge API with the validated head,
  honors master protection, and checks merged parents/tree before publication. The finalizer alone receives `checks: write`
  to attach the three required PR checks to the exact candidate after trusted CI verification. It must never push directly to master.
  Keep the repository's existing package Actions write access and PR-creation setting. A Server Release GitHub App,
  GHCR robot, `server-release-publication` environment, and extra server tag rulesets are not prerequisites.
  Separate source-free publisher runners retain exact artifact and current-workflow verification. The isolated
  image-receipt signer receives only Contents read, OIDC write, and `attestations: write` and runs the full-SHA-pinned
  attestation action before package authentication. An existing `v*`/`sha-*` image is authoritative only when its
  exact linux/amd64 config digest reconstructs the release receipt and that receipt verifies against the exact signer
  workflow/source identity. An earlier protected-master signer remains valid automatically only while its critical
  image workflow/verifier blobs are byte-identical, or when it is the exact post-hardening parent of the canonical Cut
  release commit. Current protected master owns exceptional retention and revocation through exact `allow SHA` and
  `revoke SHA` directives in `.github/release-image-attestation-trusted-workflow-shas`; `revoke SHA` overrides every
  automatic rule. Keep changed signers allowed for the full supported recovery window. Never adopt legacy or
  prepositioned aliases without that evidence. GitHub's attestation service is an integrity authority, not an availability guarantee: the
  verifier raises its bounded lookup limit, but missing/deleted/flooded legitimate evidence still fails closed and
  requires an audited alias quarantine/delete plus fresh publication.
- Server release jobs run automatically with the configured Actions identity. Cleanup is eligible only after
  read-only exact-ref inspection and must not remove a merged or moved candidate. Job isolation is not an external
  credential boundary against a user who can edit or rerun write-enabled workflows.
- **Cut release** revalidates exact metadata and runs a production-image smoke, then reuses lint, tests, release configuration,
  production-image OS scanning and populated database upgrade checks on the candidate. Version-only candidates skip platform
  build fan-out and migration rollback; normal PR/manual selection remains unchanged. Package dependency
  audits run only during weekly/manual maintenance; do not add them or expiring advisory exceptions to PR or release gates.
  Keep container OS-vulnerability checks on PRs; scan package libraries in the scheduled/manual full image scans.
- A CI-blocked validated candidate is retained. Repair the failed candidate validation, then rerun only
  failed release jobs while master and candidate remain unchanged. Do not cut another version or use the prepared
  publisher before merge. If master advances, stop and explicitly reconcile the retained candidate before a fresh
  Cut release; do not rebase, overwrite or manually merge it.
- **Cut release** selects server/web, paired native, and each OTA channel against their separately recorded successful sources.
  The server bump applies only when server/web is selected. Native fingerprint or Wear-input changes automatically prepare
  one native patch pair, reusing a valid higher reservation. Phone codes are odd, Wear codes even; abandoned reservations
  remain consumed. Prepare selected versions together in the existing protected PR/CI/merge path. OTA-only cuts use the
  exact protected source without an empty PR; unchanged cuts explicitly do nothing.
- Build both native clients once and retain attested APK/AAB hashes and runtime provenance. Main release queues the exact
  phone AAB through pinned EAS Submit to internal, verifies its ID, and permits OTA while submission continues independently.
  Wait for phone success before submitting Wear to wear:internal. Serialize all CI Play writers, enforce Console acknowledgement
  only for selected submissions, and report later submission failures without undoing OTA. Explicit Native Android Store
  Release operations promote retained codes/hashes through closed testing and protected production without rebuilding.
- Local Android package operations use `native:build`, `native:install`, and `native:submit`.
  Phone JavaScript/assets updates use `ota:publish`. Run these scripts through `npm run <script> -- <options>`.
  `native:configure` and `native:setup` are the only supporting root commands; `native:setup -- --check`
  checks prerequisites without changes, and submit includes upload readback. Keep diagnostic and version-maintenance
  workers under `scripts/` rather than adding root aliases.
  Configure uses the locked EAS CLI for authentication/first-time setup, then automatically downloads the
  default Android signing key and assigned Play key for the exact linked project and `net.darkmachines.healthtracker`.
  Do not open the interactive credential manager or require menu navigation/exit. Run in an external credentials workspace, validate the download,
  and save only absolute paths in the user's machine settings. Admit Expo authentication only to EAS, not dependency
  installation. Download only the Play submission key assigned to this exact app through EAS's internal
  credential API using the locked CLI authentication. Keep that adapter verified when upgrading EAS.
  Refresh signing and Play paths atomically; a failed download preserves the previous configuration.
  An unassigned Play key permits build/install but clears stale submission settings. Explicit local Play files
  remain an optional override; configure never uploads them or authenticates to Google. Build/submit use these
  paths by default; explicit file flags override them for one run. Keep credential contents out of saved settings.
  The public submit command supplies Console-coordination acknowledgement implicitly, with a reminder but no
  confirmation flag or prompt. Preserve the protected CI publisher and its independent credential boundaries.
  The existing `node scripts/native-internal-release.mjs prepare --bump patch` helper can allocate a native version
  without a published tag. The local path uses
  `net.darkmachines.healthtracker`, the private WireGuard origin, Expo channel `internal`, and only `internal`/`wear:internal`.
  The local entry point strips inherited signing/Play credentials, loads external Expo-format signing credentials
  only after credential-free prebuild, verifies all four artifacts,
  and records local provenance. It never creates authoritative `native-v*` tags or adopts uploads into the protected
  workflow. Install and submit verify and reuse the retained build without rebuilding.
  After tool/credential/Play onboarding and committing unused version codes, build followed by submit is sufficient
  for the local internal-track release. Build owns prebuild/signing/verification; submit owns upload and readback.
  Install and OTA publication are optional separate operations, not prerequisites to submit.
  Follow `docs/mobile-release.md` for local commands, `docs/android-internal-testing.md` for onboarding, and
  `docs/native-store-release.md` for protected releases; the server/web version stays unchanged. A later protected
  release requires a fresh higher pair and the existing GitHub attestation path.
- Expo uses fingerprint runtimes consistently for managed native builds and source exports, including repository-specific
  inputs outside Expo discovery. Verify the runtime embedded in the phone APK/AAB and bind OTA artifact provenance to the
  resolved runtime. The isolated publisher must use that exact string, never recompute from its minimal workspace.
  OTA has no signed-native-tag or Play acceptance prerequisite. Keep source exports separate from the four Expo credential
  stages and preserve one reviewer-protected production approval after internal publication. The token is project-wide;
  approval controls sequencing rather than a channel-scoped capability. Standalone OTA remains client-only.
- Each orchestration owns one draft GitHub Release identified by its originating run. Record exact sources, component
  decisions, reserved versions/codes, hashes, submission IDs, and stage outcomes. Allow only one unfinished release.
  Recovery skips successful stages and reuses retained artifacts and IDs without rebuilding or reallocating. Ambiguous
  external calls require reconciliation; abandonment preserves successes and never frees native codes. Native/OTA
  artifacts retain independent GitHub attestations. Current-master allow/revoke policy governs historical native signers.
- The configured self-host follows `latest` through its existing Compose files. Actions use an existing WireGuard
  peer and POST to the shared homelab deployment service maintained in darkmachines. Require completed HTTP 200 with
  `service: calibratehealth`, `status: succeeded`, and `healthy: true` before client publication when a server change was selected. Unselected server components require neither deployment
  nor health. A missing native baseline selects a new build instead of skipping OTA. Manual OTA stays client-only.
  The homelab owns Compose commands, deployment tokens, WireGuard peer provisioning, and firewall configuration;
  do not add host installers, SSH accounts/commands, or remote Docker management here. Keep the runner client free of
  backup prerequisites, digest overrides, deployment receipts, automatic retries, or a polling protocol. A timed-out
  POST may still be deploying; inspect service logs before retrying. Follow `deploy/self-hosted/README.md` for the
  master-only `self-hosted-testing` environment. Forward the named WireGuard and webhook token secrets through
  reusable release callers; expose them only to the deployment step. Server deployment belongs only in the standalone
  test-server deployment workflow and end-to-end release publisher. Restrict runner routing to the webhook's private
  address, verify HTTPS, serialize deployments without cancellation, and remove the runner's temporary tunnel/key.
  Modified scripts require file-level and function-level documentation comments.
- New native releases need no signed-tag private key, native tag GitHub App, or native-tag environments. Remove unused
  native-release-attestation/native-release-tags environments after migration. Keep Android signing protection, an
  EAS-assigned app credential and explicit testing-track profiles; prefer testing-only account permissions. Keep separate
  production promotion credentials. The owner approved the existing assigned credential for the initial rollout. Preserve historical server
  image verification and prepared-release recovery when editing shared legacy helpers.
- Expo's automatic check and download lifecycle remains native-owned. Client code compares only the running bundle's
  expected server contract version with client configuration at startup and server selection. Major versions must
  match; within a major, the server minor must be at least the client minor, while patch drift remains compatible. Do
  not add candidate-manifest inspection or a download/restart veto.
- Startup, server-selection, and manual-recheck compatibility requests must use `cache: 'no-store'`; response headers
  alone cannot invalidate a response cached before the server began sending the no-store policy.
- For selected server changes, successful deployment and application health gate both OTA channels; protected production approval additionally
  gates public-channel promotion. The deployment job checks only its configured target, and does not assert an exact
  server/OTA version match. Independent self-hosts still require the runtime guard and are not polled to gate OTA.
- Use **Publish prepared release** with the durable release ID to resume or explicitly abandon an integrated release.
  Before merge, retry failed original candidate jobs while refs remain unchanged. Historical server recovery still accepts
  the recorded release commit and branch. **Publish Expo OTA Update** takes an exact protected source without native_build_ref.
  **Build Release Image** remains image-only. Follow docs/native-store-release.md for configuration and rollout.

## Git And PR Workflow

- Local default branch is `master`.
- For "rebase onto latest local master" requests, use local `master`, not
  `origin/master`, unless the user says otherwise.
- If a branch backs an existing PR, preserve that PR and update the branch in
  place. Use `git push --force-with-lease` after a successful published-branch
  rebase.
- If a detached worktree has changes, stash with untracked files before rebasing
  and restore afterward.
- For metadata-only PR updates, edit only the requested PR metadata and preserve
  draft/ready-for-review state.
- When a PR maps to a tracked issue, add the appropriate close keyword to the PR
  body unless it is already present.
- For publish requests, prefer a local branch under the project/user branch
  prefix, commit only intended files, push, and open a draft PR by default unless
  the user asks for ready-for-review.

## Documentation Style

- Keep comments concise and useful: explain intent, behavior, or rationale that
  is not obvious from the code.
- Do not add broad narrative comments or duplicate what a function name already
  says.
- Keep agent guidance and README/docs in sync when workflow commands change.
- Prefer concrete commands and exact files over abstract cleanup advice.
