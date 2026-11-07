# Monitor database capacity, migrations, direct readiness and the public Hosting/TLS route; delivery is optional.
resource "google_monitoring_notification_channel" "operator" {
  count        = var.alert_email == "" ? 0 : 1
  display_name = "Calibrate operator"
  type         = "email"
  labels       = { email_address = var.alert_email }
}
locals {
  notification_channels = google_monitoring_notification_channel.operator[*].name
}
resource "google_billing_budget" "app" {
  count           = var.billing_account == "" || var.alert_email == "" ? 0 : 1
  billing_account = var.billing_account
  display_name    = "Calibrate monthly spending"
  budget_filter {
    projects = ["projects/${data.google_project.app.number}"]
  }
  amount {
    specified_amount {
      currency_code = "USD"
      units         = "100"
    }
  }
  dynamic "threshold_rules" {
    for_each = [0.25, 0.5, 1]
    content {
      threshold_percent = threshold_rules.value
    }
  }
  all_updates_rule {
    monitoring_notification_channels = local.notification_channels
  }
}
resource "google_monitoring_alert_policy" "storage" {
  display_name          = "Calibrate SQL storage above 80 percent"
  combiner              = "OR"
  notification_channels = local.notification_channels
  conditions {
    display_name = "Database storage pressure"
    condition_threshold {
      filter          = "metric.type=\"cloudsql.googleapis.com/database/disk/utilization\" AND resource.type=\"cloudsql_database\" AND resource.label.database_id=\"${var.project_id}:${google_sql_database_instance.postgres.name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0.8
      duration        = "300s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }
}
resource "google_monitoring_alert_policy" "migration" {
  display_name          = "Calibrate migration job failed"
  combiner              = "OR"
  notification_channels = local.notification_channels
  conditions {
    display_name = "Failed migration execution"
    condition_threshold {
      filter          = "metric.type=\"run.googleapis.com/job/completed_execution_count\" AND resource.type=\"cloud_run_job\" AND resource.label.job_name=\"calibrate-migrate\" AND metric.label.result=\"failed\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_DELTA"
      }
    }
  }
}
resource "google_monitoring_uptime_check_config" "readiness" {
  count        = var.serve && var.public_access ? 1 : 0
  display_name = "Calibrate Cloud Run database readiness"
  timeout      = "10s"
  period       = "300s"
  http_check {
    path         = "/api/v1/readyz"
    port         = 443
    use_ssl      = true
    validate_ssl = true
  }
  monitored_resource {
    type   = "uptime_url"
    labels = { project_id = var.project_id, host = trimprefix(google_cloud_run_v2_service.api[0].uri, "https://") }
  }
}
resource "google_monitoring_alert_policy" "readiness" {
  count                 = var.serve && var.public_access ? 1 : 0
  display_name          = "Calibrate readiness failing"
  combiner              = "OR"
  notification_channels = local.notification_channels
  conditions {
    display_name = "Readiness fails for five minutes"
    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.label.check_id=\"${google_monitoring_uptime_check_config.readiness[0].uptime_check_id}\""
      comparison      = "COMPARISON_LT"
      threshold_value = 1
      duration        = "300s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_FRACTION_TRUE"
      }
    }
  }
}

resource "google_monitoring_uptime_check_config" "hosting" {
  count        = var.serve && var.public_access ? 1 : 0
  display_name = "Calibrate public Hosting and HTTPS readiness"
  timeout      = "10s"
  period       = "300s"
  http_check {
    path         = "/api/v1/readyz"
    port         = 443
    use_ssl      = true
    validate_ssl = true
  }
  monitored_resource {
    type   = "uptime_url"
    labels = { project_id = var.project_id, host = trimprefix(var.public_origin, "https://") }
  }
}
resource "google_monitoring_alert_policy" "hosting" {
  count                 = var.serve && var.public_access ? 1 : 0
  display_name          = "Calibrate public website failing"
  combiner              = "OR"
  notification_channels = local.notification_channels
  conditions {
    display_name = "Hosting or HTTPS fails for five minutes"
    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.label.check_id=\"${google_monitoring_uptime_check_config.hosting[0].uptime_check_id}\""
      comparison      = "COMPARISON_LT"
      threshold_value = 1
      duration        = "300s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_FRACTION_TRUE"
      }
    }
  }
}
