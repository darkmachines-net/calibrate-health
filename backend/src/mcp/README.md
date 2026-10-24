# MCP transport and OAuth

Calibrate exposes a read-only, stateless Streamable HTTP MCP endpoint at `/mcp`. The official
hosted resource is `https://calibratehealth.app/mcp`; Advanced self-hosts can opt in with their own
public HTTPS origin. The tracked Codex plugin is under [plugins/calibrate-health](../../../plugins/calibrate-health).

## Data exposed

The MCP server derives the account only from the OAuth bearer token. Tool arguments never accept a
user or account ID.

- `get_recent_food_logs` returns 1-31 user-local calendar days, sanitized food entries, per-day
  tracking status and totals, COMPLETE-day averages, and current calorie-target context.
- `get_weight_trend` returns 7-365 user-local calendar days of raw weight observations, the bounded
  Calibrate trend and 95% confidence interval, evidence/freshness, a nullable weekly rate, current
  goal context, and current calorie-target context.

Food-provider IDs, barcodes, user IDs, email, date of birth, sex, height, avatar, body-fat fields,
and credentials are omitted. Only COMPLETE food days are representative. The MCP preserves the
product rule that calories-out is the profile-estimated TDEE; food and weight observations never
replace it.

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

- `calibrate:food:read` - recent food logs and completion status plus current calorie-target, configured-deficit, and profile-estimated-TDEE context.
- `calibrate:weight:read` - recent weight observations and trend uncertainty plus current goal and calorie-plan context.

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

The tracked plugin currently targets the Dark Machines self-hosted instance. Install it from a
personal or team marketplace, choose **Authenticate**, complete the Calibrate consent page, and
start a new task so Codex loads the installed skill and MCP dependency. For a different hosted
origin, update both `.mcp.json` and the skill dependency URL before installing.
