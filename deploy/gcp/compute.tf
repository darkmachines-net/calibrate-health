# Infrastructure owns runtime settings; the release toolkit owns images, migration execution and serving traffic.
locals {
  registry = "${var.region}-docker.pkg.dev/${var.project_id}/application/server"
  database_environment = {
    NODE_ENV                        = "production"
    DB_SOCKET_DIR                   = "/cloudsql/${google_sql_database_instance.postgres.connection_name}"
    DB_NAME                         = google_sql_database.app.name
    DB_SCHEMA                       = "public"
    DB_SSLMODE                      = "disable"
    DB_POOL_ACQUIRE_TIMEOUT_SECONDS = "10"
    DB_POOL_IDLE_TIMEOUT_SECONDS    = "30"
  }
  runtime_environment = merge(local.database_environment, var.application_environment, var.auth_provider == "firebase" ? {
    FIREBASE_PROJECT_ID      = var.project_id
    FIREBASE_SERVICE_ACCOUNT = google_service_account.service["api"].email
    } : {}, {
    DB_USER                  = local.runtime_database_user
    DB_POOL_MAX              = "3"
    FRONTEND_DIST_DIR        = "/app/web/dist"
    AUTH_PROVIDER            = var.auth_provider
    AUTO_LOGIN_TEST_USER     = "false"
    CALIBRATE_HOSTED_SERVICE = "true"
    PUBLIC_APP_ORIGIN        = var.public_origin
    CORS_ORIGINS             = var.public_origin
    EMAIL_DELIVERY_MODE      = var.auth_provider == "firebase" ? "disabled" : "smtp"
    # Hosting forwards this cookie; Calibrate retains session ownership with either password provider.
    SESSION_COOKIE_NAME     = "__session"
    SESSION_COOKIE_SECURE   = "true"
    SESSION_COOKIE_SAMESITE = "lax"
    MCP_ENABLED             = "true"
  })
  runtime_secrets = merge({
    DB_PASSWORD    = { secret = "database-runtime", version = google_secret_manager_secret_version.generated["database-runtime"].version }
    SESSION_SECRET = { secret = "session", version = google_secret_manager_secret_version.generated["session"].version }
    }, { for key, version in var.secret_versions : key => { secret = local.optional_secrets[key], version = version } }, var.auth_provider == "firebase" ? {
    FIREBASE_API_KEY = { secret = "firebase-api-key", version = google_secret_manager_secret_version.firebase_api_key[0].version }
  } : {})
}

resource "google_cloud_run_v2_job" "migrate" {
  count               = var.image == "" ? 0 : 1
  name                = "calibrate-migrate"
  location            = var.region
  deletion_protection = true
  template {
    task_count  = 1
    parallelism = 1
    template {
      service_account = google_service_account.service["migrator"].email
      max_retries     = 0
      timeout         = "600s"
      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [google_sql_database_instance.postgres.connection_name]
        }
      }
      containers {
        image   = var.image
        command = ["node"]
        args    = ["scripts/gcp-migrate.js"]
        resources {
          limits = { cpu = "1", memory = "512Mi" }
        }
        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }
        dynamic "env" {
          for_each = merge(local.database_environment, {
            DB_USER         = google_sql_user.database["migrator"].name, DB_POOL_MAX = "1",
            RUNTIME_DB_USER = local.runtime_database_user
          })
          content {
            name  = env.key
            value = env.value
          }
        }
        env {
          name = "DB_PASSWORD"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.secret["database-migrator"].secret_id
              version = google_secret_manager_secret_version.generated["database-migrator"].version
            }
          }
        }
        env {
          name = "RUNTIME_DB_PASSWORD"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.secret["database-runtime"].secret_id
              version = google_secret_manager_secret_version.generated["database-runtime"].version
            }
          }
        }
      }
    }
  }
  lifecycle {
    ignore_changes = [template[0].template[0].containers[0].image, client, client_version]
    precondition {
      condition     = startswith(var.image, "${local.registry}@sha256:")
      error_message = "The image must belong to this Calibrate project and region."
    }
  }
  depends_on = [google_project_iam_member.service, google_secret_manager_secret_iam_member.service]
}

resource "google_cloud_run_v2_service" "api" {
  count               = var.serve ? 1 : 0
  name                = "calibrate-api"
  location            = var.region
  deletion_protection = true
  ingress             = "INGRESS_TRAFFIC_ALL"
  # Service-wide limits avoid keeping one scheduler alive for every old Hosting-tagged revision.
  scaling {
    min_instance_count = 1
    max_instance_count = 1
  }
  template {
    service_account                  = google_service_account.service["api"].email
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    timeout                          = "60s"
    max_instance_request_concurrency = 20
    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.postgres.connection_name]
      }
    }
    containers {
      image   = var.image
      command = ["node"]
      args    = ["dist/backend/src/index.js"]
      ports {
        container_port = 3000
      }
      resources {
        limits = { cpu = "1", memory = "1Gi" }
        # The reminder scheduler runs inside the API, including between HTTP requests.
        cpu_idle          = false
        startup_cpu_boost = true
      }
      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
      dynamic "env" {
        for_each = local.runtime_environment
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.runtime_secrets
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.key == "FIREBASE_API_KEY" ? google_secret_manager_secret.firebase_api_key[0].secret_id : google_secret_manager_secret.secret[env.value.secret].secret_id
              version = env.value.version
            }
          }
        }
      }
      startup_probe {
        http_get {
          path = "/api/v1/readyz"
        }
        period_seconds    = 5
        failure_threshold = 40
        timeout_seconds   = 3
      }
      liveness_probe {
        http_get {
          path = "/api/v1/healthz"
        }
        period_seconds  = 30
        timeout_seconds = 5
      }
    }
  }
  lifecycle {
    # Release owns image rollout and Hosting pins; infrastructure must not revert an accepted deployment.
    ignore_changes = [template[0].containers[0].image, traffic, client, client_version]
    precondition {
      condition     = var.image != "" && startswith(var.image, "${local.registry}@sha256:")
      error_message = "Select a verified image from this project's registry and execute its migration job before serving."
    }
    precondition {
      condition     = var.auth_provider == "firebase" || (alltrue([for key in ["SMTP_HOST", "SMTP_FROM", "SMTP_USERNAME"] : trimspace(lookup(var.application_environment, key, "")) != ""]) && contains(keys(var.secret_versions), "SMTP_PASSWORD"))
      error_message = "Hosted registration requires Firebase Authentication or complete, pinned SMTP configuration."
    }
  }
  depends_on = [google_project_iam_member.service, google_secret_manager_secret_iam_member.service, google_cloud_run_v2_job.migrate, google_secret_manager_secret_iam_member.firebase_api_key, google_service_account_iam_member.firebase_signer, google_identity_platform_config.auth]
}
resource "google_cloud_run_v2_service_iam_member" "public" {
  count    = var.serve && var.public_access ? 1 : 0
  name     = google_cloud_run_v2_service.api[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}
