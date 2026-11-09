# Optional Sunday reports use a dedicated caller, a bounded queue, and application-level OIDC checks.
variable "weekly_reports_enabled" {
  type        = bool
  default     = false
  description = "Enable Sunday AI reports after deploying the report migration/API and configuring OpenAI workload identity and a model."
}

locals {
  # Cloud Run's deterministic service URL avoids a self-reference in the service environment.
  report_task_origin = "https://calibrate-api-${var.project_number}.${var.region}.run.app"
}

resource "google_service_account" "weekly_reports" {
  count        = var.weekly_reports_enabled ? 1 : 0
  account_id   = "calibrate-weekly-reports"
  display_name = "Calibrate weekly report task caller"
}

resource "google_cloud_tasks_queue" "weekly_reports" {
  count    = var.weekly_reports_enabled ? 1 : 0
  name     = "calibrate-weekly-reports"
  location = var.region
  rate_limits {
    max_concurrent_dispatches = 2
    max_dispatches_per_second = 1
  }
  retry_config {
    max_attempts       = 12
    max_retry_duration = "86400s"
    min_backoff        = "300s"
    max_backoff        = "3600s"
    max_doublings      = 4
  }
}

resource "google_cloud_tasks_queue_iam_member" "weekly_report_enqueuer" {
  count    = var.weekly_reports_enabled ? 1 : 0
  name     = google_cloud_tasks_queue.weekly_reports[0].name
  location = var.region
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:${google_service_account.service["api"].email}"
}

resource "google_service_account_iam_member" "weekly_report_act_as" {
  count              = var.weekly_reports_enabled ? 1 : 0
  service_account_id = google_service_account.weekly_reports[0].name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.service["api"].email}"
}

resource "google_cloud_run_v2_service_iam_member" "weekly_report_invoker" {
  count    = var.weekly_reports_enabled && var.serve ? 1 : 0
  name     = google_cloud_run_v2_service.api[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.weekly_reports[0].email}"
}

resource "google_cloud_scheduler_job" "weekly_reports" {
  count            = var.weekly_reports_enabled && var.serve ? 1 : 0
  name             = "calibrate-weekly-reports"
  region           = var.region
  schedule         = "0 * * * *"
  time_zone        = "Etc/UTC"
  attempt_deadline = "180s"
  # Hourly dispatch covers local Sundays in every IANA timezone, including fractional-hour offsets.
  http_target {
    uri         = "${local.report_task_origin}/internal/weekly-reports/dispatch"
    http_method = "POST"
    body        = base64encode("{}")
    headers     = { "Content-Type" = "application/json" }
    oidc_token {
      service_account_email = google_service_account.weekly_reports[0].email
      audience              = local.report_task_origin
    }
  }
  retry_config {
    retry_count          = 3
    min_backoff_duration = "60s"
    max_backoff_duration = "600s"
  }
  lifecycle {
    precondition {
      condition     = alltrue([for key in ["OPENAI_IDENTITY_PROVIDER_ID", "OPENAI_SERVICE_ACCOUNT_ID", "OPENAI_WEEKLY_REPORT_MODEL"] : trimspace(lookup(var.application_environment, key, "")) != ""])
      error_message = "Weekly reports require OPENAI_IDENTITY_PROVIDER_ID, OPENAI_SERVICE_ACCOUNT_ID and OPENAI_WEEKLY_REPORT_MODEL."
    }
  }
  depends_on = [google_cloud_run_v2_service_iam_member.weekly_report_invoker, google_cloud_tasks_queue_iam_member.weekly_report_enqueuer, google_service_account_iam_member.weekly_report_act_as]
}
