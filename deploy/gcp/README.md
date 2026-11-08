# GCP configuration

This module adapts [Little Say's GCP foundation](https://github.com/darkmachines-net/little-say/tree/master/deploy/gcp)
to Calibrate's combined web/API image and cookie/native session contracts.
It prepares Cloud SQL PostgreSQL 16, Artifact Registry, Secret Manager, Cloud Run,
Firebase Hosting, monitoring and GitHub Workload Identity Federation in a dedicated
Calibrate project. `auth_provider="firebase"` enables Firebase Authentication while
preserving native application identities. Both release profiles deploy to the production
GCP endpoint at `https://calibratehealth.app`; beta distributes native apps to testers.

Terraform owns infrastructure and the initial image/revision configuration. No
application is deployed by default: `image=""`, `serve=false`, `public_access=false`
and `custom_domain=""`. Supplying an image creates only the migration job; serving,
public invocation and claiming a domain are separate steps. Provider locks match
the reviewed Little Say provider versions and include platform checksums.

## Validation without an account

Install Terraform 1.9+ (CI uses 1.13.5) and Node, then run from the repository root:

```text
npm run gcp:check
node --test backend/test/gcp-migrate.test.js
npm run test:deploy
npm run gcp:test:database
npm run gcp:test:authentication
```

`gcp:check` checks formatting, initializes locked providers with the backend disabled,
validates both modules and runs mocked plans. It copies only authored Terraform,
tests and provider locks into temporary directories; local tfvars, state and backend
configuration are excluded. Provider downloads need network access, but no GCP
credentials or cloud resources are used. Set `TERRAFORM_BIN` to an absolute executable
path if Terraform is not on PATH. Windows PowerShell can use `npm.cmd`.
**Extended Validation** runs the same infrastructure checks; PRs retain their three
existing required checks.

`gcp:test:database` additionally needs Docker. It builds the backend on the host,
creates its own loopback-only PostgreSQL 16 container, applies the real Prisma
migrations, verifies runtime DML and denied administrative/ledger writes, and retries
the job before removing only that container and its disposable volume. It never
reads the worktree database configuration. This tests PostgreSQL behavior, not Cloud
SQL IAM, socket transport or Google's managed `cloudsqlsuperuser` implementation.

`gcp:test:authentication` also needs the official Firebase CLI: set
`FIREBASE_CLI_PATH` to its absolute `firebase-tools/lib/bin/firebase.js` entrypoint.
It owns loopback Auth/Postgres services and uses synthetic accounts without cloud
credentials or actual email. It tests verification/recovery, immutable bindings,
concurrent security changes, all credential families, outages and durable deletion.
The Auth Emulator does not validate imported BCRYPT hashes; it cannot certify cloud
import compatibility or IAM. Run `backend/scripts/firebase-cloud-smoke.js --project PROJECT_ID`
with explicit `FIREBASE_PROJECT_ID`, `FIREBASE_API_KEY`, `FIREBASE_SERVICE_ACCOUNT`
and Admin credentials for that check. Prefer a disposable Cloud Run job using the
API runtime identity and the verified image. It creates/removes only a synthetic
identity and sends no email; signing as the runtime identity also verifies its
self-scoped signing grant. A local operator's ability to manage Firebase does not
imply permission to sign as that service account.

## Operator inputs

The following can be supplied later. Use Calibrate's dedicated project; it may share
Little Say's billing account when authorized by the owner. Never put credential values
in tfvars, GitHub variables, Git or chat.

| Input | Purpose |
| --- | --- |
| Existing Calibrate GCP project ID and numeric project number | Required for bootstrap and checked against the selected project |
| Project billing and operator access | The owner creates/selects a project and links billing; this module does neither |
| Google Cloud CLI login / application-default credentials | Operator provisioning, separate from runtime/release identities |
| Firebase Terms acceptance | Required before enabling Hosting in the selected project |
| Authentication provider | `firebase` uses provider-owned verification/recovery; `local` requires SMTP before hosted serving |
| Alert email and optional billing account ID | Notification delivery and project-filtered $25/$50/$100 budget thresholds |
| Food-provider credentials, push keys, admin user IDs | Optional application features; configure only the services being used |
| Domain ownership/DNS and a verified application image | Needed for public cutover, along with database migration and hosted acceptance |

Cloud SQL and the always-on API incur charges after provisioning. Budget alerts are
notifications, not spending caps. `db-g1-small` is a zonal starting point, not a
high-availability database. Review capacity and costs before applying.

## Bootstrap and state

Calibrate's deployment project is `calibrate-health` (number `234661857427`) in
`us-central1`. It shares Little Say's billing account while keeping resources, IAM
and Terraform state in its own project.

Use a dedicated existing project with billing enabled. Authenticate with
`gcloud auth login --update-adc`, then set ADC's quota project with
`gcloud auth application-default set-quota-project PROJECT_ID`. Use an operator with
permission to enable APIs, manage these resources and set IAM; never grant runtime
or release identities the operator's credentials. Accept Firebase Terms in the console.

Copy `bootstrap/terraform.tfvars.example` to ignored `bootstrap/terraform.tfvars` and
fill in the independently verified project ID and number. From the repo root:

```text
terraform -chdir=deploy/gcp/bootstrap init
terraform -chdir=deploy/gcp/bootstrap plan -out=bootstrap.tfplan
terraform -chdir=deploy/gcp/bootstrap apply bootstrap.tfplan
terraform -chdir=deploy/gcp/bootstrap output -raw state_bucket
```

Bootstrap enables APIs and creates a private, versioned state bucket with deletion
protection. It never creates a project or changes billing. Keep its local state and
plan protected; securely back up the bootstrap state to the new bucket. Do not delete
or recreate an already managed project/resource to resolve an import conflict.

Copy `backend.hcl.example` to ignored `backend.hcl`, using the bucket output.
Copy `terraform.tfvars.example` to ignored `terraform.tfvars` and fill in the same
project identity. Leave image/serving/domain defaults unchanged for foundations:

```text
terraform -chdir=deploy/gcp init -backend-config=backend.hcl
terraform -chdir=deploy/gcp plan -out=foundation.tfplan
terraform -chdir=deploy/gcp apply foundation.tfplan
```

GCS owns state locking. State contains generated database and session credentials;
restrict state-bucket access to infrastructure operators and back it up securely.
The release service account receives no state access. Keep the two modules' state
separate. If Firebase, its default Hosting site or other named resources already
exist, import them into the matching resource address before applying; do not replace
existing application identities. SQL, secrets and state reject accidental destruction.

## Secrets and authentication

Terraform generates independent `calibrate-database-runtime`,
`calibrate-database-migrator` and `calibrate-session` secret versions. It creates empty
secrets for SMTP, FatSecret, USDA, web-push signing and diagnostics. Add provider values
directly through Secret Manager's console, stdin or a protected file using
`gcloud secrets versions add SECRET_ID --data-file=PROTECTED_FILE --project=PROJECT_ID`.
Set only the returned **numeric version** in `secret_versions`; `latest` is rejected.
The runtime identity can read its own database/session secrets and selected provider
secrets. The migrator reads both database passwords so it can create/update the runtime
login; it has no session or provider-secret access. Release has no direct secret reader grant.

For `auth_provider="local"`, set SMTP public settings in `application_environment`
and select `SMTP_PASSWORD` before `serve=true`. For `auth_provider="firebase"`,
Terraform enables email/password authentication, disables direct client deletion,
creates the web-app API key secret, and grants the API identity Firebase
administration plus signing on itself. Calibrate's server owns consent and deletion;
Firebase owns passwords and verification/recovery email. `EMAIL_DELIVERY_MODE` stays
`disabled` and no SMTP credentials are required. Verify delivery before inviting users.
Direct Firebase signup is disabled by default. Enabling `FIREBASE_SOCIAL_PROVIDERS`
in `application_environment` allows provider identity creation for native Google/Apple
sign-in; apply this configuration along with the backend flag. Firebase identities
alone grant no Calibrate access: the backend still requires explicit registration,
current hosted legal consent and an immutable SQL binding. Configure the providers
in Firebase and the native clients as described in the [backend guide](../../backend/README.md#native-provider-sign-in).
The sample uses Open Food Facts until provider credentials are available. FatSecret
needs both credential versions and the matching `FOOD_DATA_PROVIDER`. Configure
`ADMIN_USER_IDS` only after verifying control of an existing account as described in
the [deployment guide](../README.md#server-administration).

The selected provider becomes `AUTH_PROVIDER`; local remains the module default for
portable installations, while the example selects Firebase. Infrastructure apply
does not import existing accounts. [Account security](../../backend/README.md#authentication-and-account-isolation)
owns the runtime behavior and [migration tooling](../../backend/scripts/lib/README.md)
owns full-data migration and account-only snapshot copy contracts. An account-only copy
can create matching accounts while the original deployment remains writable; it does
not copy tracking history or synchronize subsequent account changes. Do not enable Firebase for a populated database
until every account has a reviewed immutable mapping and successful import evidence.
Hosting forwards only the specially named `__session` cookie, so the GCP runtime uses
that name with secure/lax settings and the selected public origin. See Firebase's
[cookie contract](https://firebase.google.com/docs/hosting/manage-cache#using_cookies).
An origin/cookie-name change requires signing in again; do not copy live sessions or
assume a new database shares accounts with the current server.

## First image, migrations and private verification

Build the current `Dockerfile.app` for `linux/amd64` through the existing image build
path, then copy the verified image to the `registry` output. Preserve/verify its digest.
Set `image` to `REGION-docker.pkg.dev/PROJECT_ID/application/server@sha256:DIGEST`.
Never deploy `latest`, a placeholder image or a digest from another project's registry.

With `serve=false`, plan/apply creates `calibrate-migrate`. Run it explicitly:

```text
gcloud run jobs execute calibrate-migrate --project=PROJECT_ID --region=us-central1 --wait
```

`backend/scripts/gcp-migrate.js` applies Prisma's existing migrations, creates the
separate runtime SQL login directly without Cloud SQL Admin API's implicit administrative
membership, then grants app-table DML, sequence usage and read-only migration-ledger
access. It denies schema/database creation, verifies the result, and exits. The job's
migrator owns the runtime role's grants, including retries on PostgreSQL 16. Do not
pre-create that role through the Cloud SQL user API. Migration failure must
stop rollout. The role-hardening transaction targets the dedicated public schema; do
not run it against an unrelated or shared database. Cloud SQL connector transport is
authenticated/encrypted; the local Unix socket explicitly uses `DB_SSLMODE=disable`.

After successful execution, configure the selected authentication provider and set `serve=true`. Keep
`public_access=false`. Plan/apply creates the private service. It starts Node directly,
bypassing the Compose entrypoint that runs migrations on startup. Verify the selected
image, `/api/v1/readyz`, `/api/v1/healthz`, app configuration and logs via authenticated
Cloud Run access (for example `gcloud run services proxy calibrate-api --project=PROJECT_ID --region=us-central1`).

The startup probe has a bounded 200-second window; liveness checks the process rather
than restarting it during a database outage. The pool is limited to three connections.
Service-wide minimum/maximum of one instance and continuously allocated CPU keep the
current in-process reminder scheduler running between requests, without assigning a
minimum to every old Hosting-tagged revision. Cloud Run can overlap revisions during
rollouts; these limits are not a distributed singleton guarantee. Rehearse reminder and
push deduplication during revision changes before launch or horizontal scaling.

After bootstrap, the shared release workflow owns image updates, migration execution
and serving rollout. Terraform ignores the migration/API images, Hosting traffic tags
and release client metadata so infrastructure changes preserve accepted releases.
Keep a nonempty bootstrap image in configuration. Never apply new migrations and
serving revisions concurrently. Migration rollback means an isolated restore and
compatible image, not reversing applied migration files.

## Hosting, DNS and launch checks

After private verification, set `public_access=true` and apply. Application routes
still enforce their existing account/session or bearer authorization. Verify direct
API authorization as well as the future Hosting path; a Cloud Run URL is not an auth boundary.
Add the service's exact default `run.app` hostname to `application_environment.MCP_ALLOWED_HOSTS`
before publishing. Firebase's pinned rewrites use revision-tag hostnames under that
service; the MCP host check accepts those tags while retaining the canonical public issuer.

Generate the non-secret Firebase configuration and publish only after readiness:

```text
npm run gcp:hosting:config
firebase deploy --only hosting --project PROJECT_ID --config deploy/gcp/firebase.generated.json
```

The generated rewrite uses the selected region/site and `pinTag=true`. No frontend is
built separately: web assets and API come from the same image. Verify at the selected
`public_origin`; for a rehearsal use the project's `https://PROJECT_ID.web.app` origin.
Set `custom_domain` only when ready to claim it. Terraform's `domain_dns` output shows
the required DNS updates; apply those at the domain's authoritative provider and wait
for managed HTTPS. Provisioning does not change registrar DNS.

### Cloud DNS delegation

`dns.tf` optionally manages a protected public zone in Calibrate's project. Apply
bootstrap first to enable the Cloud DNS API. Set `manage_dns=true` and the exact
`custom_domain`, then supply the reviewed `dns_records` map in operator configuration:

```hcl
dns_records = {
  hosting = { name = "calibratehealth.app.", type = "A", ttl = 300, rrdatas = ["199.36.158.100"] }
  owner   = { name = "calibratehealth.app.", type = "TXT", ttl = 300, rrdatas = ["\"hosting-site=calibrate-health\""] }
}
```

The example shows Hosting records only, not a complete migration inventory. Read
Firebase's current required DNS updates and certificate challenge before copying
their values; temporary certificate TXT values can change. Merge all TXT values at
the same name into one record set. Preserve email, verification, subdomain and
delegated-subdomain records from the old provider's full inventory. Use absolute
domain names with trailing dots in owner names and domain-valued MX/CNAME/NS/SRV
targets. Never import the old provider's apex NS/SOA: Cloud DNS generates its own.

Public DNS queries cannot enumerate the complete old zone. Obtain the provider's
record list/export or the owner's confirmation that only apex NS/SOA exist before
authorizing a nameserver switch. Query the assigned Google nameservers directly to
verify each imported record. `terraform output -json dns_nameservers` supplies the
registrar values. Keep the old zone until delegation has propagated and the domain
is verified. Existing DNSSEC DS records require a coordinated migration; the
initial zone is unsigned and must not be delegated under an old provider's DS.

This creates neither a registrar transfer nor a public application deployment.
The registrar continues to own renewals. Public Hosting and release cutover retain
the checks below. The same sequence applies to other applications, but their zones,
project identities, source inventories and Terraform state must remain separate.

Before public launch, verify registration/verification/recovery email, login/logout,
cross-user authorization, session cookies, MCP OAuth/discovery, reminders, mobile API
access, static app-link association files and HTTPS on the final domain. Hosting has
a 60-second request limit; exercise long requests and MCP connections through the real
proxy. Readiness alerts monitor both the direct Cloud Run service and the public
Hosting origin with certificate verification, covering database and domain routing failures.

Cloud SQL retains daily backups and seven days of PITR. Rehearse restoration into a
separate recovery instance, verify representative account/food/weight data there and
test state recovery into an isolated directory. Never overwrite the current instance
or current state during a rehearsal. A snapshot copy can import accounts and tracking
history while the source remains writable; it does not synchronize subsequent writes.
A final authoritative cutover needs a separate reconciliation plan. See the migration
tooling above; infrastructure apply performs neither operation.
Set `alert_email`, confirm the notification channel and optionally set `billing_account`
before launch. Empty alert input allows setup but sends no operator notifications.

## Release integration

`release.config.json` selects GCP for beta and production. The pinned shared toolkit supports an optional worker and
a custom readiness path while requiring the exact release version and Cloud Run
revision. Calibrate's `/api/v1/readyz` preserves `ok` and adds `status`, `version`, and
`revision` (`K_REVISION`, null outside Cloud Run). Its scheduler runs inside the API;
omit `worker`. The application-specific deployment configuration is:

```json
{
  "provider": "gcp",
  "project": "calibrate-health",
  "region": "us-central1",
  "api": "calibrate-api",
  "migrationJob": "calibrate-migrate",
  "hostingSite": "calibrate-health",
  "registry": "us-central1-docker.pkg.dev/calibrate-health/application/server",
  "origin": "https://calibratehealth.app",
  "readinessPath": "/api/v1/readyz"
}
```

Keep EAS preview and production public server URLs aligned with this origin. Keep package, lockfile
and both workflow pins aligned with the toolkit updater. The toolkit owns migration-before-traffic,
confirmed digest verification, revision-pinned Hosting, retry evidence and server-before-native/OTA
ordering. Terraform ignores release-owned images, traffic and client metadata; revision
names remain unset so infrastructure configuration changes can create fresh revisions.

Terraform already prepares federation for immutable owner `347558273`, repository
`1102078034` (`darkmachines-net/calibrate-health`), `refs/heads/master` and the exact
`gcp-production` environment. It uses repository ID claims, so it does not require
changing GitHub's subject customization. This follows Google's
[deployment federation guidance](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines).

Configure `gcp-production` in GitHub, restrict it to master and set
`GCP_WORKLOAD_IDENTITY_PROVIDER` and `GCP_RELEASE_SERVICE_ACCOUNT` from the matching
Terraform outputs. Retain the existing upstream release approvals; the deployment
environment should have no additional reviewer or wait timer. Both profiles share this
server while retaining separate native/OTA channels and success baselines. Preserve Calibrate's phone/Wear pair,
iOS signing, application IDs, version floors and protected production delivery.
