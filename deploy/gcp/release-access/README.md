# Terraform release access

This operator-owned module provisions the `gcp-production-plan` and
`gcp-production-apply` Google identities for Calibrate's release workflow. Its
remote state is the `release-access` prefix in the existing production state
bucket. Application releases run only the parent module and do not apply this
module. Bootstrap still owns APIs and the bucket.

Use Terraform 1.13.5 and operator application-default credentials after bootstrap:

```text
terraform -chdir=deploy/gcp/release-access init -lockfile=readonly
terraform -chdir=deploy/gcp/release-access plan -out=access.tfplan
terraform -chdir=deploy/gcp/release-access apply access.tfplan
terraform -chdir=deploy/gcp/release-access output -json github_environments
```

Review the saved plan before apply. The module is intentionally bound to Calibrate's
verified production project and existing API, migrator and weekly-report runtime
accounts. No application service, database, DNS record or release identity is
modified. The output supplies public GitHub environment variables; the parent
[setup guide](../README.md#terraform-release-environments) owns environment
protections and secret installation.

Each account has a separate federation pool restricted to the immutable GitHub
owner/repository IDs, `master` and its exact environment. Planning gets resource
readers, permission-policy inspection, application-state read and lock writes.
Applying gets infrastructure administration and application-state writes. Both
can list state object names, but direct object grants exclude bootstrap/access
state. The applier must manage project IAM for the application and is therefore
privileged; GitHub's separate required-reviewer environment is its approval
boundary. No Google service-account keys are created.

Single-project budget permissions are custom project roles, preserving the shared
billing account's access policy. Runtime impersonation is limited to the named
application service accounts. The module uses additive IAM members so existing
operator, runtime and deployment access remains intact.

`npm run gcp:check` checks all three GCP modules with mocked providers. The access
tests cover repository/environment trust separation, planner write restrictions,
application-only state grants and budget permissions.
