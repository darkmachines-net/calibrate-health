# All providers are mocked: these tests exercise plans and invariants without cloud credentials or resources.
mock_provider "google" {
  mock_data "google_project" {
    defaults = { number = "123456789012", project_id = "calibrate-test" }
  }
}
mock_provider "google-beta" {}
mock_provider "random" {}

variables {
  project_id     = "calibrate-test"
  project_number = "123456789012"
}

run "foundations_without_operator_secrets" {
  command = plan
  assert {
    condition     = length(google_cloud_run_v2_service.api) == 0 && length(google_cloud_run_v2_job.migrate) == 0
    error_message = "Foundations must not create placeholder workloads."
  }
  assert {
    condition     = length(google_monitoring_notification_channel.operator) == 0 && length(google_billing_budget.app) == 0
    error_message = "Missing alert/billing input must not block foundations or invent a recipient."
  }
  assert {
    condition     = google_sql_database_instance.postgres.settings[0].connector_enforcement == "REQUIRED" && length(google_sql_database_instance.postgres.settings[0].ip_configuration[0].authorized_networks) == 0
    error_message = "SQL must require an authenticated connector without public client networks."
  }
  assert {
    condition     = google_sql_database_instance.postgres.settings[0].backup_configuration[0].point_in_time_recovery_enabled && google_sql_database_instance.postgres.deletion_protection
    error_message = "SQL recovery and deletion protection must be enabled."
  }
  assert {
    condition     = length(google_firebase_hosting_custom_domain.app) == 0
    error_message = "Default provisioning must not claim the production domain."
  }
  assert {
    condition     = length(google_dns_managed_zone.app) == 0 && length(google_dns_record_set.app) == 0
    error_message = "Default provisioning must not create authoritative DNS zones or records."
  }
  assert {
    condition     = alltrue([for binding in local.secret_readers : binding.identity != "release"])
    error_message = "Release must not receive direct secret read access."
  }
  assert {
    condition     = !contains(keys(google_sql_user.database), "runtime") && alltrue([for binding in local.secret_readers : binding.identity != "migrator" || startswith(binding.secret, "database-")])
    error_message = "Runtime must be created without the SQL Admin API's administrative grant; migrator access is limited to database secrets."
  }
}

run "migration_before_service" {
  command = plan
  variables {
    image = "us-central1-docker.pkg.dev/calibrate-test/application/server@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  assert {
    condition     = length(google_cloud_run_v2_job.migrate) == 1 && length(google_cloud_run_v2_service.api) == 0
    error_message = "An image alone must create only the migration job."
  }
  assert {
    condition     = google_cloud_run_v2_job.migrate[0].template[0].template[0].containers[0].args == tolist(["scripts/gcp-migrate.js"])
    error_message = "Migration execution must not start the HTTP server."
  }
}

run "private_service_with_configured_mail" {
  command = plan
  variables {
    image = "us-central1-docker.pkg.dev/calibrate-test/application/server@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    serve = true
    application_environment = {
      SMTP_HOST = "smtp.example.invalid", SMTP_FROM = "Calibrate <noreply@example.invalid>", SMTP_USERNAME = "synthetic"
    }
    secret_versions = { SMTP_PASSWORD = "1" }
  }
  assert {
    condition     = length(google_cloud_run_v2_service_iam_member.public) == 0
    error_message = "Creating a service must not automatically grant public invocation."
  }
  assert {
    condition     = local.runtime_environment.AUTH_PROVIDER == "local" && local.runtime_environment.SESSION_COOKIE_NAME == "__session" && local.runtime_environment.AUTO_LOGIN_TEST_USER == "false"
    error_message = "Hosting must retain Calibrate authentication and forward its secure session cookie."
  }
  assert {
    condition     = !google_cloud_run_v2_service.api[0].template[0].containers[0].resources[0].cpu_idle && google_cloud_run_v2_service.api[0].scaling[0].min_instance_count == 1 && google_cloud_run_v2_service.api[0].scaling[0].max_instance_count == 1 && length(google_cloud_run_v2_service.api[0].template[0].scaling) == 0
    error_message = "Reminder scheduling requires CPU between requests."
  }
  assert {
    condition     = google_cloud_run_v2_service.api[0].template[0].containers[0].args == tolist(["dist/backend/src/index.js"])
    error_message = "Runtime must bypass the self-hosted startup migration entrypoint."
  }
  assert {
    condition     = local.runtime_environment.DB_POOL_MAX == "3" && local.runtime_environment.DB_SSLMODE == "disable"
    error_message = "Bound the runtime pool and delegate transport encryption to the Cloud SQL socket."
  }
  assert {
    condition     = output.firebase_config.hosting.rewrites[0].run.pinTag && output.firebase_config.hosting.site == "calibrate-test"
    error_message = "Hosting must pin the verified revision in the selected project."
  }
}

run "refuse_serving_without_mail" {
  command = plan
  variables {
    image = "us-central1-docker.pkg.dev/calibrate-test/application/server@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    serve = true
  }
  expect_failures = [google_cloud_run_v2_service.api]
}
run "firebase_service_without_smtp" {
  command = plan
  variables {
    auth_provider = "firebase"
    serve         = true
    image         = "us-central1-docker.pkg.dev/calibrate-test/application/server@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    application_environment = {
      MCP_ALLOWED_HOSTS = "calibrate-api-example-uc.a.run.app"
    }
  }
  assert {
    condition     = local.runtime_environment.AUTH_PROVIDER == "firebase" && local.runtime_environment.EMAIL_DELIVERY_MODE == "disabled" && length(google_identity_platform_config.auth) == 1
    error_message = "Firebase must own authentication and email without requiring SMTP."
  }
  assert {
    condition     = google_identity_platform_config.auth[0].client[0].permissions[0].disabled_user_signup && google_identity_platform_config.auth[0].client[0].permissions[0].disabled_user_deletion
    error_message = "Registration and deletion must pass through Calibrate's consent/data lifecycle."
  }
  assert {
    condition     = local.runtime_environment.MCP_ALLOWED_HOSTS == "calibrate-api-example-uc.a.run.app"
    error_message = "Hosting must be able to trust revision tags for its configured Cloud Run service."
  }
}
run "firebase_social_registration_preserves_application_deletion" {
  command = plan
  variables {
    auth_provider = "firebase"
    application_environment = {
      FIREBASE_SOCIAL_PROVIDERS = "google.com,apple.com"
    }
  }
  assert {
    condition     = !google_identity_platform_config.auth[0].client[0].permissions[0].disabled_user_signup && google_identity_platform_config.auth[0].client[0].permissions[0].disabled_user_deletion
    error_message = "Provider identities need signup enabled; application deletion must still go through Calibrate."
  }
  assert {
    condition     = local.runtime_environment.FIREBASE_SOCIAL_PROVIDERS == "google.com,apple.com"
    error_message = "The runtime provider allowlist and Firebase signup configuration must agree."
  }
}

run "public_service_and_operator_alerts" {
  command = plan
  variables {
    image           = "us-central1-docker.pkg.dev/calibrate-test/application/server@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    serve           = true
    public_access   = true
    public_origin   = "https://calibrate.example.com"
    custom_domain   = "calibrate.example.com"
    alert_email     = "operator@example.invalid"
    billing_account = "000000-000000-000000"
    application_environment = {
      SMTP_HOST = "smtp.example.invalid", SMTP_FROM = "Calibrate <noreply@example.invalid>", SMTP_USERNAME = "synthetic"
    }
    secret_versions = { SMTP_PASSWORD = "1" }
  }
  assert {
    condition     = length(google_cloud_run_v2_service_iam_member.public) == 1 && length(google_monitoring_uptime_check_config.readiness) == 1 && length(google_firebase_hosting_custom_domain.app) == 1
    error_message = "Explicit public setup must include invocation, readiness monitoring and the selected domain."
  }
  assert {
    condition     = google_monitoring_uptime_check_config.hosting[0].monitored_resource[0].labels.host == "calibrate.example.com" && google_monitoring_uptime_check_config.hosting[0].http_check[0].validate_ssl
    error_message = "Public monitoring must verify HTTPS on the final Hosting origin."
  }
  assert {
    condition     = length(google_billing_budget.app) == 1 && length(local.notification_channels) == 1
    error_message = "Operator input must enable budget and alert delivery."
  }
  assert {
    condition     = strcontains(google_iam_workload_identity_pool_provider.github.attribute_condition, "assertion.repository_id == '1102078034'") && strcontains(google_iam_workload_identity_pool_provider.github.attribute_condition, "assertion.environment == 'gcp-production'") && strcontains(google_iam_workload_identity_pool_provider.github.attribute_condition, "assertion.ref == 'refs/heads/master'")
    error_message = "Federation must remain bound to Calibrate's immutable repository, branch and environment."
  }
}
run "refuse_foreign_registry" {
  command = plan
  variables {
    image = "us-central1-docker.pkg.dev/little-say/application/server@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  expect_failures = [google_cloud_run_v2_job.migrate]
}
run "refuse_floating_image" {
  command = plan
  variables {
    image = "us-central1-docker.pkg.dev/calibrate-test/application/server:latest"
  }
  expect_failures = [var.image]
}
run "refuse_unpinned_secret" {
  command = plan
  variables {
    secret_versions = { SMTP_PASSWORD = "latest" }
  }
  expect_failures = [var.secret_versions]
}
run "refuse_secret_in_plaintext_environment" {
  command = plan
  variables {
    application_environment = { SMTP_PASSWORD = "synthetic" }
  }
  expect_failures = [var.application_environment]
}
run "refuse_wrong_project_number" {
  command = plan
  variables {
    project_number = "987654321098"
  }
  expect_failures = [data.google_project.app]
}

run "dns_can_be_prepared_before_public_serving" {
  command = plan
  variables {
    custom_domain = "calibratehealth.app"
    manage_dns    = true
    dns_records = {
      firebase = { name = "calibratehealth.app.", type = "A", ttl = 300, rrdatas = ["199.36.158.100"] }
      mail     = { name = "calibratehealth.app.", type = "MX", ttl = 3600, rrdatas = ["10 mail.example.invalid."] }
      consent  = { name = "calibratehealth.app.", type = "TXT", ttl = 300, rrdatas = ["\"hosting-site=calibrate-test\"", "\"existing-verification\""] }
    }
  }
  assert {
    condition     = google_dns_managed_zone.app[0].dns_name == "calibratehealth.app." && google_dns_managed_zone.app[0].visibility == "public" && !google_dns_managed_zone.app[0].force_destroy
    error_message = "Prepare the selected protected public zone without replacing registrar delegation."
  }
  assert {
    condition     = google_dns_record_set.app["mail"].rrdatas == tolist(["10 mail.example.invalid."]) && length(google_dns_record_set.app["consent"].rrdatas) == 2 && length(google_cloud_run_v2_service_iam_member.public) == 0
    error_message = "Preserve existing records alongside Firebase records independently of public serving."
  }
}
run "refuse_foreign_dns_record" {
  command = plan
  variables {
    custom_domain = "calibratehealth.app"
    manage_dns    = true
    dns_records   = { foreign = { name = "notcalibratehealth.app.", type = "A", ttl = 300, rrdatas = ["199.36.158.100"] } }
  }
  expect_failures = [var.dns_records]
}
run "refuse_old_apex_nameservers" {
  command = plan
  variables {
    custom_domain = "calibratehealth.app"
    manage_dns    = true
    dns_records   = { old = { name = "calibratehealth.app.", type = "NS", ttl = 300, rrdatas = ["ns.example.invalid."] } }
  }
  expect_failures = [var.dns_records]
}
run "refuse_duplicate_dns_record_sets" {
  command = plan
  variables {
    custom_domain = "calibratehealth.app"
    manage_dns    = true
    dns_records = {
      first  = { name = "calibratehealth.app.", type = "TXT", ttl = 300, rrdatas = ["\"one\""] }
      second = { name = "calibratehealth.app.", type = "TXT", ttl = 300, rrdatas = ["\"two\""] }
    }
  }
  expect_failures = [var.dns_records]
}
