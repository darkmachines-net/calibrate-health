# Backend

[src/index.ts](src/index.ts) composes Express, authentication, route mounts, static Expo
delivery, diagnostics, and the reminder scheduler. Prisma and browser sessions share the
pool in [configuration](src/config/README.md). [openapi](openapi/README.md) owns the wire
contract; [services](src/services/README.md) own transactional domain behavior.

Run `npm --prefix backend run typecheck`, `npm --prefix backend test`, and
`npm --prefix backend run build` from the root. The supported development stack is
the root `npm run dev` launcher. [prisma](prisma/README.md) owns migration guidance.

## Authentication and account isolation

Browser sessions use Postgres-backed HttpOnly cookies, secure and host-scoped in
production/staging with SameSite=Lax. Browser mutation Origin checks and exact
`CORS_ORIGINS` protect sibling hosts as well as cross-site requests. A split-origin
deployment using SameSite=None must retain HTTPS and secure cookies. Native sessions
use opaque bearer tokens hashed at rest; refresh rotation uses compare-and-swap so
one refresh token can mint only one successor. Rate limits apply independently to
login, registration, refresh, password changes, and pairing issuance.

Every account-owned query derives the account from the authenticated principal and
includes it in database predicates. Numeric resource IDs never authorize access.
Wear routes additionally require a Wear session. Device IDs, push ownership, and
mutation provenance come from that session, never caller JSON. Helmet supplies
baseline headers; a deployment-specific CSP is not currently supplied.

Account access is `full`, `email_verification_required`, or
`legal_acceptance_required`. Restricted sessions retain verification, legal,
support, export, deletion, and logout access. Registration records explicit consent
to current legal versions; migrations never invent legal acceptance. Verification
tokens in local mode last 24 hours and reset tokens 30 minutes; both are purpose-bound, single-use
hashes. Request/resend routes return generic 202 responses to avoid enumeration.
Reset revokes browser/native/Wear sessions and MCP grants. Local password changes
retain only the intended initiating session; Firebase password changes require a new
sign-in on every device. [MCP](src/mcp/README.md) documents OAuth.

Hosted accounts require `CALIBRATE_HOSTED_SERVICE=true` and a canonical HTTPS
`PUBLIC_APP_ORIGIN`. Local authentication uses `EMAIL_DELIVERY_MODE=smtp` and
the `SMTP_*` settings in [.env.example](.env.example). Firebase authentication uses
Firebase's hosted verification/reset messages and leaves SMTP delivery disabled.
Hosted registration fails closed when delivery is unavailable. Local self-hosts
may disable delivery and own their recovery arrangements.
Never log tokens, request bodies, SMTP details, or raw provider/database errors.

`AUTH_PROVIDER=firebase` selects [firebaseAuthority.ts](src/services/firebaseAuthority.ts)
for registration, password checks, recovery, verification and deletion. Supply the
project, API key and runtime service account described in [configuration](src/config/README.md).
The server uses keyless Admin access; no Firebase token or refresh token reaches
the browser/native clients. Existing cookies, opaque native tokens, Wear pairing
and MCP flows retain their API contracts. New registrations receive a fresh UID;
existing accounts require an immutable SQL mapping, never adoption by email.

Before honoring existing credentials or issuing tokens, the server checks provider
disablement, deletion, email/verification changes and token revocation time. Changes
advance the SQL security generation and revoke all local credential families.
Provider outages fail closed. Firebase's revocation timestamps have second precision;
server-mediated password changes and resets additionally revoke local credentials
explicitly. SQL row locks serialize reconciliation with verified session issuance.
This adds a provider read to authenticated requests; measure latency and capacity
before scaling. Retained local hashes never provide outage fallback.

Firebase deletion first records durable intent and revokes local access. Provider
deletion precedes SQL cascade; startup/minute maintenance retries unfinished deletion.
Registration cleanup targets only the freshly allocated UID. An uncertain provider
create with no SQL mapping requires operator inspection; never repair it by email linking.
Use `npm run gcp:test:authentication` for isolated Auth Emulator/Postgres lifecycle
checks. [GCP deployment](../deploy/gcp/README.md) owns cloud rehearsal and cutover.

## Portability and deletion

[accountLifecycle.ts](src/services/accountLifecycle.ts) owns versioned account exports
and password-confirmed deletion. Exports include user-visible tracking, avatar,
activity, and legal history, but exclude credentials, sessions, push endpoints,
device IDs, checkpoints, tombstones, and internal replay metadata. Read the serializer
for the current export version instead of copying that number into documentation.
Deletion cascades from the user row and clears the browser session. External exports,
device-local pending writes, logs, and backup copies need their own cleanup/retention.
The instance operator owns restoration procedures that cannot reactivate deleted accounts.

## Operational boundaries

Run one application process: the scheduler and SSE fanout are process-local and
have no distributed leadership/pub-sub. [Deployment](../deploy/README.md) owns TLS,
backup, readiness, and operator configuration. Diagnostics are disabled by default;
[observability.ts](src/observability.ts) uses only opaque IDs and fixed aggregate
dimensions. [Operations](../scripts/README.md#operations) describes collection.

Food imports retain immutable calorie/serving snapshots. Activity is observational;
it never replaces profile-estimated TDEE. Nutrition-label scanning has its own
[bounded local OCR module](src/services/nutritionLabels/README.md).
