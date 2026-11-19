# Operator-managed Terraform plan and apply identities, kept in state separate from application infrastructure.
terraform {
  required_version = ">= 1.9, < 2.0"
  backend "gcs" {
    bucket = "calibrate-health-tfstate-234661857427"
    prefix = "release-access"
  }
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }
}

provider "google" {
  project = "calibrate-health"
}

data "google_project" "app" {
  project_id = "calibrate-health"
  lifecycle {
    postcondition {
      condition     = self.number == "234661857427"
      error_message = "Release access must remain in the verified Calibrate project."
    }
  }
}

locals {
  state_bucket = "calibrate-health-tfstate-234661857427"
  state_object = "projects/_/buckets/${local.state_bucket}/objects/application/default.tfstate"
  lock_object  = "projects/_/buckets/${local.state_bucket}/objects/application/default.tflock"
  environments = { plan = "gcp-production-plan", apply = "gcp-production-apply" }
  project_roles = {
    plan = [
      "roles/artifactregistry.reader", "roles/cloudsql.viewer", "roles/run.viewer",
      "roles/secretmanager.viewer", "roles/firebase.viewer", "roles/dns.reader",
      "roles/monitoring.viewer", "roles/iam.securityReviewer", "roles/iam.workloadIdentityPoolViewer",
      "roles/serviceusage.serviceUsageConsumer", "roles/cloudtasks.viewer", "roles/cloudscheduler.viewer"
    ]
    apply = [
      "roles/artifactregistry.admin", "roles/cloudsql.admin", "roles/run.admin",
      "roles/secretmanager.admin", "roles/firebase.admin", "roles/dns.admin",
      "roles/monitoring.editor", "roles/iam.serviceAccountAdmin", "roles/iam.workloadIdentityPoolAdmin",
      "roles/resourcemanager.projectIamAdmin", "roles/serviceusage.serviceUsageConsumer",
      "roles/cloudtasks.admin", "roles/cloudscheduler.admin"
    ]
  }
  memberships = merge([for identity, roles in local.project_roles : {
    for role in roles : "${identity}-${role}" => { identity = identity, role = role }
  }]...)
}

resource "google_service_account" "terraform" {
  for_each     = local.environments
  project      = data.google_project.app.project_id
  account_id   = "calibrate-tf-${each.key}"
  display_name = "Calibrate Terraform ${each.key}"
}

# Separate pools prevent a valid planning token from using the apply service account.
resource "google_iam_workload_identity_pool" "terraform" {
  for_each                  = local.environments
  project                   = data.google_project.app.project_id
  workload_identity_pool_id = "calibrate-tf-${each.key}"
}
resource "google_iam_workload_identity_pool_provider" "github" {
  for_each                           = local.environments
  workload_identity_pool_id          = google_iam_workload_identity_pool.terraform[each.key].workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  attribute_mapping = {
    "google.subject"          = "assertion.sub"
    "attribute.repository_id" = "assertion.repository_id"
  }
  attribute_condition = "assertion.repository_owner_id == '347558273' && assertion.repository_id == '1102078034' && assertion.repository == 'darkmachines-net/calibrate-health' && assertion.ref == 'refs/heads/master' && assertion.environment == '${each.value}'"
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}
resource "google_service_account_iam_member" "federation" {
  for_each           = local.environments
  service_account_id = google_service_account.terraform[each.key].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.terraform[each.key].name}/attribute.repository_id/1102078034"
}
resource "google_project_iam_member" "terraform" {
  for_each = local.memberships
  project  = data.google_project.app.project_id
  role     = each.value.role
  member   = "serviceAccount:${google_service_account.terraform[each.value.identity].email}"
}

# Single-project budget permissions avoid granting authority over the shared billing account.
resource "google_project_iam_custom_role" "budget" {
  for_each    = local.environments
  project     = data.google_project.app.project_id
  role_id     = "calibrateTerraformBudget${title(each.key)}"
  title       = "Calibrate Terraform budget ${each.key}"
  permissions = concat(["resourcemanager.projects.get", "billing.resourcebudgets.read"], each.key == "apply" ? ["billing.resourcebudgets.write"] : [])
}
resource "google_project_iam_member" "budget" {
  for_each = local.environments
  project  = data.google_project.app.project_id
  role     = google_project_iam_custom_role.budget[each.key].name
  member   = "serviceAccount:${google_service_account.terraform[each.key].email}"
}

# Listing needs a bucket-level grant; object reads/writes remain restricted to the application state and lock.
resource "google_project_iam_custom_role" "state_list" {
  project     = data.google_project.app.project_id
  role_id     = "calibrateTerraformStateList"
  title       = "Calibrate Terraform state listing"
  permissions = ["storage.objects.list"]
}
resource "google_storage_bucket_iam_member" "state_list" {
  for_each = local.environments
  bucket   = local.state_bucket
  role     = google_project_iam_custom_role.state_list.name
  member   = "serviceAccount:${google_service_account.terraform[each.key].email}"
}
resource "google_storage_bucket_iam_member" "state_read" {
  for_each = local.environments
  bucket   = local.state_bucket
  role     = "roles/storage.objectViewer"
  member   = "serviceAccount:${google_service_account.terraform[each.key].email}"
  condition {
    title      = "calibrate-application-state-read"
    expression = "resource.name == '${local.state_object}'"
  }
}
resource "google_storage_bucket_iam_member" "state_write" {
  for_each = local.environments
  bucket   = local.state_bucket
  role     = "roles/storage.objectAdmin"
  member   = "serviceAccount:${google_service_account.terraform[each.key].email}"
  condition {
    title      = "calibrate-application-${each.key}"
    expression = each.key == "plan" ? "resource.name == '${local.lock_object}'" : "resource.name in ['${local.state_object}', '${local.lock_object}']"
  }
}

resource "google_service_account_iam_member" "apply_runtime" {
  for_each           = toset(["api", "migrator", "weekly-reports"])
  service_account_id = "projects/${data.google_project.app.project_id}/serviceAccounts/calibrate-${each.key}@${data.google_project.app.project_id}.iam.gserviceaccount.com"
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.terraform["apply"].email}"
}

output "github_environments" {
  description = "Public environment variables only; GitHub secrets are configured separately."
  value = { for identity, environment in local.environments : identity => {
    environment     = environment
    provider        = google_iam_workload_identity_pool_provider.github[identity].name
    service_account = google_service_account.terraform[identity].email
  } }
}
