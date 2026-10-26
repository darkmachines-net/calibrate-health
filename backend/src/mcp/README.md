# MCP progress explorer and OAuth

Calibrate exposes a read-only, stateless Streamable HTTP MCP endpoint at `/mcp`. The official
hosted resource is `https://calibratehealth.app/mcp`; Advanced self-hosts can opt in with their own
public HTTPS origin. The tracked Codex plugin is under [plugins/calibrate-health](../../../plugins/calibrate-health).

## Data exposed

The MCP server derives the account only from the OAuth bearer token. Tool arguments never accept a
user or account ID.

- `open_progress_explorer` opens the MCP App with a 90-day overview by default. Paired optional
  `start_date` and `end_date` select any retained historical window of up to 365 inclusive local days.
- `get_progress_summary` returns the same data without opening another panel. Summaries include
  available-history bounds, current goal/plan, daily chart data, food coverage, and meal/weekday patterns.
- `compare_progress_periods` accepts `first` and `second` objects containing explicit date bounds,
  each up to 365 days. It returns normalized summaries, evidence counts, and second-minus-first differences.
- `get_recent_food_logs` returns 1-31 user-local calendar days, sanitized food entries, per-day
  tracking status and totals, COMPLETE-day averages, and current calorie-target context.
- `get_weight_trend` returns 7-365 user-local calendar days of raw weight observations, the bounded
  Calibrate trend and 95% confidence interval, evidence/freshness, a nullable weekly rate, current
  goal context, and current calorie-target context.

The two existing tools retain their defaults and accept optional `end_date` for older history.
There is no age cutoff: use adjacent windows for longer analyses and combine sums/counts instead of
averaging averages. Invalid, reversed, future-ending, or oversized ranges fail explicitly.

Food-provider IDs, barcodes, user IDs, email, date of birth, sex, height, avatar, body-fat fields,
and credentials are omitted. Only COMPLETE food days are representative. The MCP preserves the
product rule that calories-out is the profile-estimated TDEE; food and weight observations never
replace it.

## Analysis boundaries

Only COMPLETE days enter intake averages and meal/weekday patterns. Missing meals on a COMPLETE
day contribute zero to that meal's average; missing or unfinished days never imply zero intake.
Every aggregate includes its sample count. Historical intake-versus-target comparisons use only
saved canonical daily comparisons, with a separate denominator for days having valid targets.
Missing historical targets stay null; the current plan does not backfill them.

The current goal and plan are read using actual current time, even when the selected window is old.
Maintenance has no completion percentage or projection date. Weight-change summaries use actual
first/last in-range observations and report their dates. Modeled pace describes the selected period
end, not average pace over the range. The canonical model retains its bounded active/warmup horizon;
older observations are visible without fabricated trend values. See the
[domain services](../services/README.md#weight-trend-and-calibration) for model ownership.

Related reads share a repeatable-read snapshot. MCP analysis never materializes trends, captures
daily plans, or changes health data. Independently granted food/weight scopes control which history
and analysis sections are queried and returned. Food permission includes the existing derived calorie
plan and canonical tracking status, whose internal readers can use weight inputs; it does not expose
weight observations, weight-history bounds, modeled weight, or goal progress. Activity, body fat, and
nutrition macros are not exposed.

## App UI and development

The isolated TypeScript/SVG App lives in `ui/`; `progressTypes.ts` is its pure JSON contract with the
server. The opening tool links an HTML MCP Apps resource and declares global sidebar and conversation
entrypoints through `openai/ui` metadata. A local installation needs its MCP server running for the
host to discover those launchers. Data tools remain useful in clients without
UI, and panel refreshes call them through the host bridge without opening additional panels.
Question buttons immediately send the selected dates, comparison, and focus into the current host
conversation. Hosts without message support show selectable question text instead.
The default weight view shows one chart and the current goal. Intake and comparison are separate
views, each with at most two chat prompts. Preset periods apply immediately; custom dates, trend
evidence, and logging patterns use disclosures so secondary information does not fill the initial view.

All data and messages pass through the MCP Apps SDK bridge. The iframe receives no OAuth credentials,
makes no direct API calls, stores no health data locally, and renders untrusted labels as text.
It has no logging/editing controls or independent chat backend. User units/timezone and host theme
are retained; charts include textual summaries and distinguish incomplete data from observations.

The backend-owned `build-mcp-app.mjs` bundles SDK, code, and styles into `backend/dist/mcp-app`.
Normal backend build/test and development commands prepare this resource; the production image's
existing backend-dist copy includes it. No additional port or service is needed. Backend dependencies
are sufficient to build it; the Expo runtime is not included in the iframe.

From the repository root:

```sh
npm --prefix backend run typecheck
npm --prefix backend test
npm --prefix backend run build
npm run test:mcp-app
node scripts/calibrate-plugin.mjs check
```

The browser suite uses synthetic data and a mock host bridge, including message delivery, range changes,
scope/error states, and narrow/theme layouts. It requires the root Playwright Chromium installation
prepared by `npm run setup`. MCP browser/plugin tests are selected PR checks and run in `ci:local`.

## OAuth contract

Calibrate is both the OAuth authorization server and MCP resource server. It supports OAuth 2.1
authorization code with S256 PKCE, dynamic registration for public clients, one-hour access tokens,
rotating 30-day refresh tokens, and token/grant revocation. Passwords are submitted only to the
Calibrate-hosted consent page; clients receive opaque OAuth credentials, never the password.

Credentials are random and only purpose-bound SHA-256 hashes are stored. Authorization requests
expire after 10 minutes and one-use codes after 5 minutes. Refresh-token replay revokes the entire
grant. Password change/reset and account deletion invalidate or remove grants. Account-access policy
is rechecked on approval and use; the official hosted service requires current email verification and legal acceptance.

Scopes:

- `calibrate:food:read` - food history, completion status and patterns plus current calorie-target, configured-deficit, and profile-estimated-TDEE context.
- `calibrate:weight:read` - weight history and trend uncertainty plus current goal and calorie-plan context.

Discovery and protocol routes:

- `GET /.well-known/oauth-protected-resource/mcp`
- `GET /.well-known/oauth-authorization-server`
- `GET|POST /authorize`
- `POST /register`
- `POST /token`
- `POST /revoke`
- `POST /oauth/approve`
- `POST /mcp` (`GET` and `DELETE` return 405 because the transport is stateless)

OAuth connections can be listed and revoked through `GET /api/v1/user/connected-apps` and
`DELETE /api/v1/user/connected-apps/:connectionId`.

## Deployment configuration

The official hosted deployment enables MCP automatically when
`CALIBRATE_HOSTED_SERVICE=true`; its canonical resource derives from `PUBLIC_APP_ORIGIN`, falling
back to `https://calibratehealth.app`.

Advanced self-hosting is opt-in:

```dotenv
MCP_ENABLED=true
```

The normal same-origin resource URL and allowed hostname derive from `PUBLIC_APP_ORIGIN`.
`MCP_PUBLIC_URL` is an optional intentional override; when set it must be public, stable,
credential-free, and HTTPS in production/staging. It is the exact OAuth resource identifier, so
reverse proxies must preserve `/mcp` and the OAuth routes on the same origin. `MCP_ALLOWED_HOSTS`
optionally adds hostnames beyond the canonical resource hostname and loopback development hosts.

For worktree development, set `MCP_ENABLED=true` in the repo-local `.env`; setup generates a local
`MCP_PUBLIC_URL` using that worktree's backend port. Local HTTP is allowed only for loopback.

After applying the committed Prisma migrations, verify discovery without exposing credentials:

```sh
curl https://health.example.com/.well-known/oauth-protected-resource/mcp
curl -i -X POST https://health.example.com/mcp \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

The second request should return `401` with a `WWW-Authenticate` challenge pointing to the first
resource-metadata URL. Never place OAuth tokens, food entries, or weight values in deployment logs.

## Client plugin

The plugin MCP declaration uses remote OAuth and contains no secret:

```json
{
  "mcpServers": {
    "calibrate": {
      "type": "http",
      "url": "https://calibratehealth.darkmachines.net/mcp",
      "auth": "oauth"
    }
  }
}
```

The tracked plugin targets the Dark Machines self-hosted instance. Its
[package README](../../../plugins/calibrate-health/README.md) owns marketplace registration,
installation, authentication, and publication checks. Deploy the compatible server before publishing
the immutable plugin revision to the existing DarkMachines marketplace. The App is delivered by the
server; it is not copied into the plugin cache. For a different hosted origin, update both
`.mcp.json` and the skill dependency URL before installing.
