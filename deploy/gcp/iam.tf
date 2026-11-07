# Release trust is bound to the verified immutable repository IDs, master and one deployment environment.
resource "google_service_account" "service" {
  for_each     = toset(["api", "migrator", "release"])
  project      = data.google_project.app.project_id
  account_id   = "calibrate-${each.key}"
  display_name = "Calibrate ${each.key}"
}
locals {
  project_roles = {
    api      = concat(["roles/cloudsql.client"], var.auth_provider == "firebase" ? ["roles/firebaseauth.admin"] : [])
    migrator = ["roles/cloudsql.client"]
    release  = ["roles/run.developer", "roles/firebasehosting.admin", "roles/firebase.viewer", "roles/serviceusage.serviceUsageConsumer"]
  }
  memberships = merge([for identity, roles in local.project_roles : {
    for role in roles : "${identity}-${role}" => { identity = identity, role = role }
  }]...)
  secret_readers = merge({
    runtime       = { identity = "api", secret = "database-runtime" }
    session       = { identity = "api", secret = "session" }
    migrator      = { identity = "migrator", secret = "database-migrator" }
    runtime_setup = { identity = "migrator", secret = "database-runtime" }
  }, { for key in keys(var.secret_versions) : key => { identity = "api", secret = local.optional_secrets[key] } })
}
resource "google_project_iam_member" "service" {
  for_each = local.memberships
  project  = data.google_project.app.project_id
  role     = each.value.role
  member   = "serviceAccount:${google_service_account.service[each.value.identity].email}"
}
resource "google_secret_manager_secret_iam_member" "service" {
  for_each  = local.secret_readers
  secret_id = google_secret_manager_secret.secret[each.value.secret].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.service[each.value.identity].email}"
}
resource "google_artifact_registry_repository_iam_member" "release" {
  repository = google_artifact_registry_repository.application.name
  location   = var.region
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.service["release"].email}"
}
resource "google_service_account_iam_member" "release_runtime" {
  for_each           = toset(["api", "migrator"])
  service_account_id = google_service_account.service[each.key].name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.service["release"].email}"
}
resource "google_iam_workload_identity_pool" "github" {
  project                   = data.google_project.app.project_id
  workload_identity_pool_id = "calibrate-release"
}
resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  attribute_mapping = {
    "google.subject"          = "assertion.sub"
    "attribute.repository_id" = "assertion.repository_id"
  }
  # ID claims work with standard or immutable GitHub subjects without weakening repository ownership checks.
  attribute_condition = "assertion.repository_owner_id == '347558273' && assertion.repository_id == '1102078034' && assertion.repository == 'darkmachines-net/calibrate-health' && assertion.ref == 'refs/heads/master' && assertion.environment == 'gcp-production'"
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}
resource "google_service_account_iam_member" "federation" {
  service_account_id = google_service_account.service["release"].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository_id/1102078034"
}
resource "google_service_account_iam_member" "firebase_signer" {
  count              = var.auth_provider == "firebase" ? 1 : 0
  service_account_id = google_service_account.service["api"].name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.service["api"].email}"
}
resource "google_secret_manager_secret_iam_member" "firebase_api_key" {
  count     = var.auth_provider == "firebase" ? 1 : 0
  secret_id = google_secret_manager_secret.firebase_api_key[0].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.service["api"].email}"
}
