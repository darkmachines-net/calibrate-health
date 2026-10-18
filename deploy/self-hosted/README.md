# Automatic deployment through the homelab webhook

GitHub-hosted Actions use an existing WireGuard peer and call the shared `deployer` service in
[darkmachines](https://github.com/MChartier/darkmachines/tree/master/deployer). This repository configures only the
runner's temporary tunnel and request. The homelab owns the service, Compose configuration, tokens, WireGuard peers,
routing, and firewall. No host installer, uninstaller, deployment SSH account, or sudo rule is needed here.

When server/web changes are selected, the shared release workflow publishes the GHCR image (including latest), calls the webhook, and requires completed deployment health before dependent client publication. An unchanged server is neither deployed nor health-checked. Production OTA retains its approval. Use `npm run release -- recover --release-id ID` for read-only inspection and an explicit recovery action to continue. A timed-out request may still be deploying; inspect service logs and reconcile before another request. Standalone `plan --operation deploy --release-id ID` uses retained server evidence; `plan --operation ota` stays client-only. The webhook healthy response is health evidence, not proof of an exact deployed digest.

## Webhook contract

The runner makes one authenticated request with no body, query parameters, or deployment overrides:

```http
POST /deploy/calibratehealth
Authorization: Bearer <Calibrate-specific deployment token>
```

The homelab maps `calibratehealth` to its locally configured Compose project and `app` service, pulls the configured
`latest` image, upgrades only that service, and waits for Docker health. The runner requires HTTP **200** and:

```json
{"service":"calibratehealth","status":"succeeded","healthy":true}
```

The Calibrate image includes the existing DB-backed `/api/v1/readyz` Docker healthcheck, so the homelab does not need
to add a Compose override. Publish an image containing this change before the first webhook deployment.

An accepted/pending response, redirect, malformed JSON, unhealthy result, timeout, or disconnect fails the job.
The runner never automatically retries a POST. A timed-out request may still be deploying on the host; check service
logs before rerunning. Compose and application secrets stay on the homelab. The client does not select a digest,
assert an exact server/OTA version match, run Docker remotely, or add backups, locks, receipts, rollback, or pruning.

## GitHub environment configuration

Provide an existing WireGuard peer for this repository with its own private key and IPv4 address. Peer provisioning
is managed separately on the homelab. The peer must reach the deployment service's private HTTPS address, and the
service must authorize Calibrate's token. Keep the endpoint private using the homelab's existing network policy.

Create **`self-hosted-testing`**. Under deployment branches and tags, choose **Selected branches and tags**, allow
only branch **`master`**, and add no tag rules. Keep `master` protected. Leave reviewers and wait timers off for
automatic deployment; retain the separate `production` OTA approval.

Set these **environment secrets**, not repository secrets:

| Secret | Value |
| --- | --- |
| `DEPLOY_WG_ENDPOINT` | Reachable VPN hostname/IPv4 and UDP port, e.g. `vpn.example.com:51820` |
| `DEPLOY_WG_PRIVATE_KEY` | Existing Calibrate runner peer's WireGuard private key |
| `DEPLOY_TOKEN` | Calibrate-specific token from darkmachines (43-128 base64url characters) |

Set these **environment variables**:

| Variable | Value |
| --- | --- |
| `DEPLOY_HOST` | Private IPv4 serving the deployment HTTPS endpoint through WireGuard |
| `DEPLOY_URL` | Full endpoint: `https://deployer.darkmachines.net/deploy/calibratehealth` |
| `DEPLOY_WG_ADDRESS` | Existing runner peer's IPv4 address, without CIDR suffix |
| `DEPLOY_WG_PUBLIC_KEY` | WireGuard server's public key |

`DEPLOY_HOST` is the webhook destination, which may differ from the VPN gateway. The runner routes only this `/32`
through WireGuard and resolves the URL hostname to that address for this request, preserving HTTPS certificate
verification. No private DNS or SSH host-key setup is needed. The request bypasses HTTP proxies, does not follow
redirects, and passes its token to curl through stdin. Response bodies are not printed to Actions logs.

To replace the SSH configuration, add `DEPLOY_URL` and `DEPLOY_TOKEN`, remove `DEPLOY_SSH_USER`,
`DEPLOY_SSH_PRIVATE_KEY`, and `DEPLOY_SSH_KNOWN_HOSTS`, and check that `DEPLOY_HOST` points to the HTTPS service.
WireGuard configuration names are unchanged. `SELF_HOSTED_DEPLOY_ENABLED` is unused. Keep repository `EXPO_TOKEN`,
Expo environment settings, and the existing `production` approval for OTA.

The end-to-end reusable callers forward the three deployment secret names to the deployment job, where values
resolve in the protected environment. Only the webhook step receives them. OTA-only jobs receive no deployment
parameters. The job verifies current protected-master workflow authority before using credentials.

## Rollout and recovery

1. Finish the [deployer rollout in darkmachines](https://github.com/MChartier/darkmachines/blob/master/deployer/ROLLOUT.md)
   and provide the existing peer credentials and Calibrate token. Use `deployer.darkmachines.net` in `DEPLOY_URL`;
   the runner derives both TLS hostname verification and private address resolution from this URL.
2. Configure the master-only environment above.
3. After merge, review and run the shared release plan to publish the first image containing the built-in healthcheck and execute the
   image/deploy/OTA sequence. Confirm the deployment job succeeds before approving production OTA.
4. Once `latest` includes that healthcheck, **Deploy self-hosted server** from `master` with no inputs independently
   tests or retries the webhook. It performs a real upgrade and may briefly restart `app`. Use **Publish prepared
   release** for recovery of a prepared end-to-end release.

The client allows 15 seconds to connect and 780 seconds for the complete POST. The service and reverse proxy must
allow synchronous completion within that window. The darkmachines service bounds pull/start/health commands to
660 seconds total with a 690-second socket deadline; its Traefik backend allows 720 seconds for response headers.
The Actions job allows 20 minutes for setup, deployment, and cleanup. Runs use concurrency group
`self-hosted-testing-deploy` with `cancel-in-progress: false`.

On failure, inspect homelab deployer logs and application health before rerunning. If a pull/start command is interrupted,
the deployer may return HTTP 409 with `deployment_requires_reconciliation` on subsequent attempts. Follow its rollout
guide to reconcile Docker state before restarting the controller and retrying; rerunning Actions alone cannot clear it.
A standalone deployment does not resume a blocked release; rerun that release's failed jobs to continue to OTA.
The runner removes its temporary tunnel and key on success or failure, with a separate workflow cleanup step for
cancellation. Server peers and firewall rules are managed outside this repository.

## Validation

`npm run test:deploy` checks authentication arguments, private routing, HTTP/result validation, bounded requests,
no automatic retries, and cleanup using mocked commands. Compose tests still cover the repo's self-hosting templates.
`npm run test:release` checks image/deploy/OTA ordering, production approval, secret forwarding, and client-only OTA.
The homelab service owns the Docker deployment tests. These checks do not contact the private server; complete the
live workflow rollout above.
