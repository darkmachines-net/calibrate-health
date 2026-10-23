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
- All TypeScript surfaces: `npm run lint`
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
  `AppActionRow`, and consequential notices use `AppNotice`. Follow `mobile/src/components/README.md`
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

- Ordinary feature/fix PRs must not change server or native versions and their diagnostic/API/package mirrors.
- `release.config.json` maps the existing manifests and declares Calibrate's paired Android targets, odd/even reservations, real native-metadata server dependency, OTA destinations and environments. The pinned `@mchartier/expo-release` package owns orchestration and provider behavior. Do not copy its engine or add consumer retry/persistence/publication hooks.
- Use `npm run release -- validate|plan|run|status|recover`. Plan from a clean committed source. Protected operations dispatch read-only requests to default-branch handlers; approval environments remain in shared workers. Device installation and machine setup use `native:install`, `native:configure`, and `native:setup`.
- Keep package, lockfile and reusable-worker pins at the same reviewed full SHA. Privileged workers obtain trusted tooling independently. Source inspection/install/export has no publication credentials; preserve build/signing/publication separation.
- GitHub Releases are the durable ledger. Keep original producing runs, provider IDs, reservations, destinations, artifact hashes and current signer revocations. Unknown remote outcomes block retries until explicit reconciliation. Local receipts remain local evidence and cannot establish protected provenance.
- Keep phone completion before Wear submission and verified phone handoff before dependent OTA. Internal OTA deliberately preserves source-validated runtime behavior; production requires exact retained native compatibility. Independent successful stages survive failure elsewhere.
- Legacy releases are intentionally unsupported. Test new-format recovery with synthetic receipts; never dispatch live releases during validation.
- Keep existing deployment infrastructure and runtime guards. A healthy webhook response is health evidence, not proof of an exact deployed digest. Client/server major versions must match; the server minor must be at least the client's, while patch drift remains compatible. Compatibility fetches use `cache: 'no-store'`; Expo owns automatic update checks/downloads.
- Follow `docs/native-store-release.md` for hosted operations and recovery, `docs/mobile-release.md` for local builds, and `docs/android-internal-testing.md` for onboarding. Retain application-specific native validation and physical-device acceptance.

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

- Do not create or check in a central `docs/` tree, generated prose, change reports,
  point-in-time audits, release worksheets, or screenshot evidence archives. Put
  historical results and review evidence in the PR/issue or ignored local artifacts.
- Document current behavior at its owner: implementation rationale in comments and
  module architecture, invariants and supported commands in a module-scope `README.md`.
  Keep each fact in one owning module; link to it elsewhere instead of duplicating it.
  Group related implementation into a cohesive subdirectory when that clarifies ownership.
- When adding or updating an authored code file, add or update its file-level
  documentation comment to explain its responsibility and important boundaries.
- When adding or updating a public/exported function or method, add or update its
  documentation comment with the behavioral contract, meaningful inputs/results,
  side effects, failure semantics and constraints as applicable. Do not merely
  restate the name or repeat TypeScript types. Document non-obvious private helpers too.
- Authored JavaScript/TypeScript uses JSDoc `@file` overviews and JSDoc on exported
  functions/public methods; Kotlin uses KDoc. Keep generated/vendor output excluded
  and update its generator or owning module documentation instead.
- Run `npm run lint:eslint`, `npm run lint:kotlin`, and `npm run test:lint` for
  documentation enforcement. Kotlin lint requires Java 17 or newer; its isolated
  [tool project](tools/kotlin-lint/README.md) does not require an Android SDK.
  Use the existing JSDoc ESLint and Detekt rules; never add bespoke documentation scanners,
  disable the rules to avoid writing comments, or use empty boilerplate comments.
- Executable contracts/fixtures (OpenAPI, schemas, reviewed test snapshots) belong
  with their consumers and are distinct from generated documentation.
  Do not change already-applied SQL migration bytes to add comments; document their
  current constraints beside the schema or in the Prisma module README instead.

- Keep comments concise and useful: explain intent, behavior, or rationale that
  is not obvious from the code.
- Do not add broad narrative comments or duplicate what a function name already
  says.
- Keep agent guidance, comments and module READMEs in sync when workflow commands change.
- Prefer concrete commands and exact files over abstract cleanup advice.
