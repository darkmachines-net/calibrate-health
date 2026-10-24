# Backend configuration

## Database connections

The application uses one `pg.Pool` for Prisma, browser sessions and readiness.
Prisma CLI resolves the same explicit settings; it runs in its own process and
must be counted separately. Connection settings do not provision infrastructure or change credential authority. Authentication defaults to local.

`DATABASE_URL` takes precedence over component credentials. Otherwise supply
`DB_HOST`, `DB_NAME`, `DB_USER` (alias `DB_USERNAME`) and `DB_PASSWORD` (alias
`DB_PASS`); `DB_PORT` defaults to 5432. Credentials and database/schema names are
URL-escaped. Existing local/Compose URLs need no changes.

| Optional setting | Accepted integers | Prisma CLI URL parameter |
| --- | --- | --- |
| `DB_POOL_MAX` | 1–100 | `connection_limit` |
| `DB_POOL_ACQUIRE_TIMEOUT_SECONDS` | 1–300 | `pool_timeout` and `connect_timeout` |
| `DB_POOL_IDLE_TIMEOUT_SECONDS` | 1–3600 | `max_idle_connection_lifetime` |

These parameters may also be specified in `DATABASE_URL`. When both sources (or
duplicate parameters) are present they must agree; connect and acquisition
timeouts must agree because pg uses one timer for both. Empty, fractional, zero,
negative, nonnumeric and out-of-range values fail before opening a connection.
These are configuration guardrails, not measured capacity recommendations.
Unset settings retain driver defaults (pg maximum 10, no acquisition timeout,
idle timeout 10 seconds); Prisma CLI retains its own defaults. Opt in to all
three for explicit bounds. pg receives milliseconds and CLI receives seconds.
Acquisition timeout is not a query timeout. Idle cleanup requires the process
to be scheduled; it is not a guarantee while a runtime is suspended.

Illustrative configuration: `DB_POOL_MAX=3`,
`DB_POOL_ACQUIRE_TIMEOUT_SECONDS=5`, `DB_POOL_IDLE_TIMEOUT_SECONDS=30`.
A combined budget could reserve `(2 old + 2 new web processes) × 3 = 12`,
plus two overlapping job/CLI processes × 3 = 6, plus 3 administrative connections:
21 total before other applications and additional safety headroom. Count
all replicas, revision overlap, jobs, admin and other applications against the
database's usable limit. Autoscaler limits are not a strict connection or cost
guarantee; this example selects no production tier or availability policy.

## TCP, sockets and TLS

TCP uses the URL authority or `DB_HOST`; a query `host` is never silently
forwarded. Unix sockets require explicit `DB_SOCKET_DIR=/absolute/directory`.
For component configuration omit `DB_HOST`; for a direct URL use `localhost`
as the placeholder authority. A URL `host` parameter, if supplied, must match
the directory. Runtime pg receives the directory as its host; CLI receives the
encoded `host` parameter. Socket operation needs a Unix host/provider and is
not a Windows native socket path. A socket example is
`postgresql://user:password@localhost/app?sslmode=disable` together with
`DB_SOCKET_DIR=/cloudsql/PROJECT:REGION:INSTANCE` (placeholders only).

Socket mode requires explicit `sslmode=disable` or `DB_SSLMODE=disable`;
the operator must separately provide and validate the authenticated encrypted
socket transport. No proxy, connector, credential or endpoint is provisioned.
Conflicting TCP/socket settings fail rather than changing the destination.

An explicit blank/whitespace SSL setting is rejected rather than disabling TLS;
omit the override to use the URL setting. Conflicting duplicate URL SSL modes
are rejected, while a nonblank `DB_SSLMODE` takes precedence. Selected modes are
trimmed and normalized consistently in runtime and CLI. Unknown modes are rejected;
accepted modes are `disable`, `require`, `verify-ca`, `verify-full`, `prefer`, `allow`.
Existing explicit SSL semantics are preserved: `DB_SSLMODE` overrides the URL value,
`disable` disables TLS, explicit `require` encrypts without certificate
verification, and `verify-ca`/`verify-full` retain pg certificate verification.
Component composition defaults to `require`; use a verified transport
and trusted CA configuration where required. Arbitrary URL query parameters are not passed
to pg; this is not general libpq connection-string compatibility.

URL `schema` takes precedence over `DB_SCHEMA`; the selected schema goes to
both Prisma's adapter and pg `search_path`, and is reflected in the CLI URL.
Schema-only Prisma generate/format/validate still work without live credentials.
Scripts must call `disconnectDatabase()` to end Prisma and its owned pool,
including when Prisma disconnect fails. Idle connection failures are reported
without driver credentials and removed by pg; later acquisition can replace them.

Synthetic regression coverage lives in `../../test/database-utils.test.js`
and `../../test/database-pool.test.js`; no live database or cloud is needed.

## Other configuration boundaries

[credentialProvider.ts](credentialProvider.ts) rejects every `AUTH_PROVIDER` except
`local`; incidental Firebase variables do not activate hosted authentication.
[cors.ts](cors.ts) parses exact browser origins. [nativePush.ts](nativePush.ts),
[emailDelivery.ts](emailDelivery.ts), and [mcp.ts](mcp.ts) validate optional capability
configuration before routes use it. Secrets belong in the environment, never database rows.
