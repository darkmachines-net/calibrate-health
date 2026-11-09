# Outputs contain destinations and public configuration only, never generated passwords or tokens.
output "registry" {
  value = local.registry
}
output "workload_identity_provider" {
  value = google_iam_workload_identity_pool_provider.github.name
}
output "release_service_account" {
  value = google_service_account.service["release"].email
}
output "openai_workload_identity" {
  description = "Public Google identity claims for the OpenAI project service-account mapping; no credentials."
  value = {
    email    = google_service_account.service["api"].email
    subject  = google_service_account.service["api"].unique_id
    issuer   = "https://accounts.google.com"
    audience = lookup(var.application_environment, "OPENAI_WIF_AUDIENCE", "https://api.openai.com/v1")
  }
}
output "sql_connection" {
  value = google_sql_database_instance.postgres.connection_name
}
output "api_url" {
  value = try(google_cloud_run_v2_service.api[0].uri, "")
}
output "domain_dns" {
  value = try(google_firebase_hosting_custom_domain.app[0].required_dns_updates, [])
}
output "firebase_config" {
  description = "Write to ignored deploy/gcp/firebase.generated.json after readiness verification."
  value = {
    hosting = {
      site     = google_firebase_hosting_site.app.site_id
      public   = "public"
      rewrites = [{ source = "**", run = { serviceId = "calibrate-api", region = var.region, pinTag = true } }]
      headers = [for route in ["/api/**", "/mcp{,/**}", "/oauth/**"] : {
        source = route, headers = [{ key = "Cache-Control", value = "private, no-store" }]
      }]
    }
  }
}
