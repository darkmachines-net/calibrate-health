# Owns durable SQL and generated credentials; operator-provided provider secrets never enter Terraform.
resource "google_artifact_registry_repository" "application" {
  project       = data.google_project.app.project_id
  repository_id = "application"
  location      = var.region
  format        = "DOCKER"
  docker_config {
    immutable_tags = true
  }
}
resource "google_sql_database_instance" "postgres" {
  project             = data.google_project.app.project_id
  name                = "calibrate-postgres"
  region              = var.region
  database_version    = "POSTGRES_16"
  deletion_protection = true
  settings {
    edition                     = "ENTERPRISE"
    tier                        = "db-g1-small"
    availability_type           = "ZONAL"
    disk_size                   = 10
    disk_type                   = "PD_SSD"
    disk_autoresize             = true
    deletion_protection_enabled = true
    connector_enforcement       = "REQUIRED"
    ip_configuration {
      # Cloud Run's authenticated connector needs an address; no client networks are authorized.
      ipv4_enabled = true
    }
    backup_configuration {
      enabled                        = true
      start_time                     = "08:00"
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7
      backup_retention_settings {
        retained_backups = 7
      }
    }
    maintenance_window {
      day          = 7
      hour         = 9
      update_track = "stable"
    }
  }
  lifecycle {
    prevent_destroy = true
  }
}
resource "google_sql_database" "app" {
  name     = "calibrate"
  instance = google_sql_database_instance.postgres.name
  lifecycle {
    prevent_destroy = true
  }
}
resource "random_password" "generated" {
  for_each = toset(["database-runtime", "database-migrator", "session"])
  length   = 48
  special  = false
}
resource "google_sql_user" "database" {
  # Runtime is created without Cloud SQL's implicit administrative membership by the migration job.
  for_each = toset(["migrator"])
  instance = google_sql_database_instance.postgres.name
  name     = "calibrate_${each.key}"
  password = random_password.generated["database-${each.key}"].result
}
locals {
  runtime_database_user = "calibrate_runtime"
  optional_secrets = {
    SMTP_PASSWORD                       = "smtp-password"
    FATSECRET_CLIENT_ID                 = "fatsecret-client-id"
    FATSECRET_CLIENT_SECRET             = "fatsecret-client-secret"
    USDA_API_KEY                        = "usda-api-key"
    WEB_PUSH_PRIVATE_KEY                = "web-push-private-key"
    CALIBRATE_DIAGNOSTICS_METRICS_TOKEN = "diagnostics-metrics-token"
  }
}
resource "google_secret_manager_secret" "secret" {
  for_each  = setunion(toset(keys(random_password.generated)), toset(values(local.optional_secrets)))
  project   = data.google_project.app.project_id
  secret_id = "calibrate-${each.key}"
  replication {
    auto {}
  }
  lifecycle {
    prevent_destroy = true
  }
}
resource "google_secret_manager_secret_version" "generated" {
  for_each    = random_password.generated
  secret      = google_secret_manager_secret.secret[each.key].id
  secret_data = each.value.result
}
resource "google_secret_manager_secret" "firebase_api_key" {
  count     = var.auth_provider == "firebase" ? 1 : 0
  secret_id = "calibrate-firebase-api-key"
  replication {
    auto {}
  }
  lifecycle { prevent_destroy = true }
}
resource "google_secret_manager_secret_version" "firebase_api_key" {
  count       = var.auth_provider == "firebase" ? 1 : 0
  secret      = google_secret_manager_secret.firebase_api_key[0].id
  secret_data = data.google_firebase_web_app_config.auth[0].api_key
}
