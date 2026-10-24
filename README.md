# calibrate

Calibrate is a hosted calorie tracker for people who want to lose or maintain weight by logging food and weight, then
comparing daily intake with an estimated target based on their profile. The official service is the default for routine
use; self-hosting remains available as an Advanced option for operators who want to run the application and database.

- Official service: https://calibratehealth.app
- Launch clients: English Web/PWA, Android phone, and Wear OS
- Stack: Expo Router + React Native Web, Node.js + TypeScript + Express, Postgres (Prisma)

Note: calibrate is not medical advice.

## Features

- Multi-user accounts (email/password)
- Profile-driven calorie math (Mifflin-St Jeor BMR, activity-based TDEE, fixed daily deficit targets)
- Daily food logging with fixed meal categories (manual entry + food database search)
- Food search + barcode scanning (FatSecret default; USDA optional with API key; Open Food Facts fallback)
- My Foods library + recipe builder for reusable entries
- Nutrition-label photo scanning with editable calories, serving quantity/unit, and a title before saving
- Lose It CSV import (food logs + weigh-ins)
- Weight logging + trend visualization
- Goal projection from a steady deficit
- Observational Health Connect activity that never automatically changes the calorie target
- Read-only MCP access to recent food logs and weight trends through revocable OAuth connections

#### FatSecret terms + attribution

If you enable the FatSecret provider, you must comply with the FatSecret Platform API Terms of Use and Attribution Policy.
The app includes the required "Powered by fatsecret" link on the landing page and above food search results when
FatSecret is the active provider; keep that link intact. Review the FatSecret platform docs for the latest terms and
attribution requirements: https://platform.fatsecret.com/docs/guides

## Docs

- Weight trend model: `docs/weight-trend-model.md`
- MCP, OAuth, and the Codex plugin: `docs/mcp.md`
- Deployment (Compose self-hosting): `deploy/README.md`
- Database connections and optional pool bounds: [configuration](docs/database-connections.md)
- Expo web dev/build/PWA: `docs/expo-web.md`
- Expo Android client: `mobile/README.md`
- First hosted release scope: `docs/release-scope.md`
- Android/Wear Play and health release worksheet: `docs/play-console-health-release-checklist.md`
- Current release-candidate notes: `docs/releases/0.12.0-native-0.1.0-wear-0.2.0.md`
- Security model and release threat review: `docs/security.md`, `docs/security-release-threat-model.md`
- Architecture decisions: `docs/architecture/`

## Advanced: self-hosting

### Docker Compose (single machine)

The portable production Compose files under `deploy/` support either Caddy or an existing Traefik deployment, with
either external Postgres or a private in-stack Postgres volume. An optional backup overlay creates age-encrypted
automated dumps with retention. The deployment intentionally has no AWS/Terraform dependency.

Quick start:

1. Build the production image:

   ```sh
   docker build -f Dockerfile.app -t calibrate:local .
   ```

2. Copy `deploy/.env.example` to `deploy/.env`, set `APP_IMAGE`, `APP_HOST`, `SESSION_SECRET`, and configure the chosen
   database mode. Generate an age identity and set its public recipient if using the recommended backup overlay.

3. Start the stack:

   ```sh
   cd deploy
   docker compose --env-file .env \
     -f docker-compose.yml \
     -f docker-compose.postgres.yml \
     -f docker-compose.backup.yml \
     up -d --build
   ```

   Omit `docker-compose.postgres.yml` when using external Postgres. Replace `docker-compose.yml` with
   `docker-compose.traefik.yml` when the host already runs Traefik.

Notes:

- Caddy needs ports 80/443 reachable from the internet and DNS pointing at the machine. Traefik uses its existing
  external network and certificate resolver.
- The app runs committed Prisma migrations before becoming ready. Compose and both proxies use DB-backed readiness.
- Restore drills refuse non-empty databases and require the age private identity plus explicit confirmation.

See [deploy/README.md](deploy/README.md) for external/in-stack commands, upgrade behavior, resource guidance,
encrypted backup monitoring, and the clean-instance restore procedure.

## Development

For Android phone and Wear releases, use the [local native guide](docs/mobile-release.md):
build packages with `npm run native:build`, publish Expo updates with `ota:publish`,
install the last build with `native:install`, or submit its AABs with `native:submit`.
Run `npm run <script> -- --help` for required options. Protected production releases have a
[separate maintainer guide](docs/native-store-release.md).

### One-command quickstart

Prerequisites are Node.js `20.19+` or `22.12+`, npm, Docker Desktop, and Docker
Compose `2.22+`. The launcher starts Docker Desktop on Windows or macOS when it
is installed but not running.

```sh
npm run dev
```

That command installs missing host dependencies, creates an isolated Compose
project for the current worktree, builds the shared development image, starts
its Postgres instance, applies migrations, seeds deterministic data, and runs
the backend and Expo web services with Compose Watch. Stable URLs are printed
before the services attach.

Codex, tests, linting, builds, and Prisma run directly in the worktree on the
host. Only the live `web`, `backend`, and `postgres` services run in Docker.
Each worktree has its own ports, session cookie, Compose project, image, and
persistent database volume.

Generated local infrastructure values live in `.dev.env`. This file is
gitignored and contains worktree-local database/session credentials and VAPID
keys. User-owned provider credentials remain in the root `.env`; neither file
is copied into the development image.

The normal lifecycle is:

- `npm run setup`: install host dependencies and generate Prisma without
  starting Docker.
- `npm run native:setup`: install and verify the Windows Android build toolchain
  plus host dependencies. See [native setup](docs/mobile-release.md#set-up-once).
- `npm run native:configure`:
  download EAS-managed Android signing and the assigned Play service-account key so build and submit need no repeated arguments.
- `npm run dev`: prepare and run the full stack with seeded-user auto-login.
- `npm run dev:manual-auth`: run the same stack with auto-login disabled.
- `npm run dev:expo`: run the native Expo dev-client bundler on the host
  against the current worktree backend; keep `npm run dev` running separately.
- `npm run dev:setup`: build images, start Postgres, migrate, and seed without
  starting web/backend.
- `npm run dev:build`: install host dependencies and validate the Expo web
  production export.
- `npm run dev:status`: show the current worktree's services and URLs.
- `npm run dev:reset`: reset and reseed only the current worktree database.
- `npm run dev:down`: remove the current worktree's containers and network;
  retain its database volume.

Rerun `npm run dev` after changing `.env`; Compose recreates services when their
effective environment changes. Dependency or Prisma manifest edits rebuild the
affected development image automatically.

#### Food data providers

Set food provider values in the repo-local `.env`. Explicit
`FOOD_DATA_PROVIDER` wins; otherwise local development selects FatSecret when
both FatSecret credentials exist and USDA in other cases. USDA uses
api.data.gov's `DEMO_KEY` when no key was supplied.

Supported values are `fatsecret`, `usda`, and `openfoodfacts`. The effective
allowlisted values are copied into `.dev.env` for Compose; GitHub/Codex tokens
are never forwarded to application containers.

#### Codex app usage

The Codex worktree setup hook copies the source checkout's `.env` once,
installs host dependencies, generates Prisma, and allocates worktree ports. It
does not start containers, so code-only worktrees do not retain idle stacks.
Codex actions call the same `npm run dev`, `npm test`, build, database, and CI
commands used outside the app.

#### Dev test user

The seed script creates a deterministic local test account (`test@calibratehealth.app`). To speed up onboarding
iterations, the local app auto-logs in this user by default. The backend creates the seeded data on demand when the
database is otherwise ready:

- Start with automatic test-user login: `npm run dev`
- Exercise the login and registration screens instead: `npm run dev:manual-auth`
- Reset the test user onboarding state: `npm run dev:reset-test-user-onboarding`

### Common scripts

- `npm run db:migrate`: start the current worktree database, apply committed
  migrations, and seed when needed.
- `npm run db:migrate:create -- --name <name>`: create and apply a development
  migration against the current worktree database.
- `npm run db:studio`: open Prisma Studio against the current worktree database.
- `npm run setup:deps`: install root/mobile and backend host dependencies when
  their lockfile/runtime hash changed.
- `npm test`: runs backend, API client, and Expo client unit tests.
- `npm --prefix backend run db:push:reset`: dev-only schema reset using `prisma db push` (fast, skips migrations).
- `npm run build`: build the Expo web production export.
- `npm run build:mobile`: type-check the Expo React Native Android client.
- `npm run dev:expo`: start host Metro for the native Android dev client,
  targeting the current worktree's exposed backend port.
- `npm run test:mobile`: run mobile unit tests.
- `npm run test:web:e2e`: build the Expo web release export and run its local Chrome E2E suite.
- `npm run lint`: run ESLint with zero warnings, then type-check the backend, shared domain package, API client, and Expo client with unused-code checks.
- `npm run lint:eslint`: check authored JavaScript and TypeScript, including React hook dependencies; any warning or error fails the command. `npm run typecheck` runs just the TypeScript checks.
- PR merges require **ESLint (zero warnings)**, **Backend, Shared, API Client, and Mobile Typecheck**, and **Required Tests**. The test gate requires selected backend/API/mobile suites to pass and permits skips only for unaffected surfaces.
- Automated release PRs satisfy these checks through the protected finalizer, which verifies the exact candidate's reusable CI results before publishing the three required checks. Validation jobs remain read-only.
- `npm run ci:local`: run the local equivalent of PR CI (backend and Expo web builds, Expo release validation, backend/API/mobile type-checking, and backend/mobile tests).
- `npm run test:coverage`: collect backend and Expo client coverage.

### Docker Compose development stack

```sh
npm run dev
```

`compose.dev.yaml` is intentionally launched through `scripts/dev-stack.mjs`;
the launcher supplies the current worktree's generated project name, ports,
credentials, and database URL. Direct `docker compose up` bypasses that
isolation and is not the supported workflow.

## PWA (installable)

The production Expo web client is configured as a Progressive Web App, so it can be installed on desktop/mobile and
added to a home screen. The tagged `Dockerfile.app` image serves this export from the same origin as the API.

- For local API and Expo web work, run `npm run dev`.
- Test the release artifact locally with `npm run build:expo-web` followed by
  `npm --prefix mobile run preview:web`, then open `http://localhost:4174` and use the browser install UI.

Push notes:

- Browser push registration and delivery require backend VAPID env vars: `WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY`, and `WEB_PUSH_SUBJECT`.
- Native Android push is disabled by default for self-hosting. An operator can set `NATIVE_PUSH_MODE=expo` only after accepting the Expo Push Service data boundary.
- The development launcher generates missing VAPID keys in `.dev.env`. Set
  `WEB_PUSH_*` in the root `.env` to override them.
- Direct backend runs outside the standard stack must set `WEB_PUSH_*`
  explicitly (see `.env.example` and `backend/.env.example`).

## Android native client

The `mobile/` workspace is an Expo development-build React Native app. It uses native navigation, secure token storage,
Expo push notifications, haptics, camera barcode scanning, and the shared Calibrate API client.

Quick start:

```sh
npm run dev
```

This standard path brings up the local API, Postgres, and Expo web client. Host-side native Android commands still use
the commands in `mobile/README.md` when Android build tools are available.

For Android emulator development, the app defaults to `http://10.0.2.2:3000` in dev builds so it can reach the local
backend. Official Android builds default to `https://calibratehealth.app`. A previously selected self-hosted origin
continues to win after restart; custom server setup is an Advanced Android sign-in option. Production Web/PWA deployments
always use the corresponding same-origin backend and do not expose a server selector.

Native auth is bearer-token based and additive to the existing browser cookie session flow. Mobile tokens are opaque to
the client, hashed at rest on the server, and stored on-device through Expo SecureStore.

## Production / staging (single origin)

Production is hosted at `https://calibratehealth.app` and staging is hosted at `https://staging.calibratehealth.app`.

This app is configured for a "single origin" deployment where the Expo web client and backend share the same host. In that
setup you do not need CORS, and cookies should remain host-scoped.

Recommended backend env vars:

- `NODE_ENV=production` (or `staging` for staging)
- `DATABASE_URL=...`
- `SESSION_SECRET=...` (use a different value for staging vs prod)
- `FRONTEND_DIST_DIR=...` when the backend should serve the built SPA (the production Docker image sets this already)

Notes:

- Leave `CORS_ORIGINS` unset for single-origin prod/staging deployments.
- Leave `SESSION_COOKIE_DOMAIN` unset so prod and staging sessions do not collide in the same browser.
- Keep `SESSION_SECRET` stable within an environment so sessions remain valid across deploys.
- `SESSION_COOKIE_SECURE` defaults to `true` in production and staging; override only if you are intentionally serving over plain HTTP.
- Wear pairing requires HTTPS in production and staging. A LAN/loopback-only self-host can explicitly set
  `ALLOW_INSECURE_WEAR_PAIRING=true`, but the backend will warn because pairing credentials and health traffic
  can be intercepted over cleartext HTTP.

See [docs/security.md](docs/security.md) for the browser CSRF posture, native bearer-token model,
authentication rate limits, and device-session behavior.

Optional redacted JSON request logs and bearer-protected, process-local counters are documented in
[docs/observability.md](docs/observability.md). Diagnostics are disabled by default and have no external SaaS exporter.

The shared client uses the stable `/api/v1` resource API. See
[docs/api-versioning.md](docs/api-versioning.md) and [docs/openapi/v1.yaml](docs/openapi/v1.yaml)
for compatibility and wire-contract policy.

To explore calorie-calibration outcomes with editable preset histories, run `npm run dev:calibration-lab`. See [docs/calibration-insights.md](docs/calibration-insights.md) for the evaluator and execution contract.
