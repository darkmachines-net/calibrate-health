# Inputs require Calibrate's own project identity; billing may use an owner-approved shared account.
variable "project_id" {
  type        = string
  description = "Existing, billing-enabled GCP project dedicated to Calibrate."
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id)) && var.project_id != "little-say"
    error_message = "Select a valid Calibrate project ID; Little Say's project must not be reused."
  }
}
variable "project_number" {
  type        = string
  description = "Independently verified numeric project identity; checked before provisioning."
  validation {
    condition     = can(regex("^[0-9]+$", var.project_number)) && var.project_number != "1003645384869"
    error_message = "Supply Calibrate's numeric project number."
  }
}
variable "region" {
  type    = string
  default = "us-central1"
}
variable "auth_provider" {
  type        = string
  default     = "local"
  description = "Credential authority. Firebase owns verification/recovery email; local requires SMTP for the hosted service."
  validation {
    condition     = contains(["local", "firebase"], var.auth_provider)
    error_message = "Select local or firebase authentication."
  }
}
variable "image" {
  type        = string
  default     = ""
  description = "Verified Artifact Registry image digest; empty provisions foundations only."
  validation {
    condition     = var.image == "" || can(regex("^[a-z0-9-]+-docker.pkg.dev/[a-z0-9-]+/application/server@sha256:[a-f0-9]{64}$", var.image))
    error_message = "Use an immutable application/server@sha256 digest, never a tag."
  }
}
variable "serve" {
  type        = bool
  default     = false
  description = "Create the web/API service only after executing the migration job successfully."
}
variable "public_access" {
  type        = bool
  default     = false
  description = "Allow unauthenticated HTTP invocation after private readiness checks. Application auth remains required."
}
variable "public_origin" {
  type    = string
  default = "https://calibratehealth.app"
  validation {
    condition     = can(regex("^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?$", var.public_origin))
    error_message = "Use a bare HTTPS origin without path, query, credentials or trailing slash."
  }
}
variable "custom_domain" {
  type        = string
  default     = ""
  description = "Optional Firebase Hosting domain; empty avoids claiming or changing a live domain."
  validation {
    condition     = var.custom_domain == "" || "https://${var.custom_domain}" == var.public_origin
    error_message = "The custom domain must match public_origin."
  }
}
variable "application_environment" {
  type        = map(string)
  default     = {}
  description = "Non-secret application settings only. Credentials belong in Secret Manager."
  validation {
    condition = alltrue([for key in keys(var.application_environment) : contains([
      "SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USERNAME", "SMTP_FROM", "FOOD_DATA_PROVIDER",
      "ADMIN_USER_IDS", "NATIVE_PUSH_MODE", "WEB_PUSH_PUBLIC_KEY", "WEB_PUSH_SUBJECT", "WEIGHT_TREND_MODEL",
      "CALIBRATE_DIAGNOSTICS_ENABLED", "MCP_ALLOWED_HOSTS"
    ], key)])
    error_message = "Only documented non-secret app settings may be supplied; runtime/auth/database settings are owned by this module."
  }
}
variable "secret_versions" {
  type        = map(string)
  default     = {}
  description = "Environment name to numeric Secret Manager version. No secret values or latest aliases."
  validation {
    condition = alltrue([for key, version in var.secret_versions : contains([
      "SMTP_PASSWORD", "FATSECRET_CLIENT_ID", "FATSECRET_CLIENT_SECRET", "USDA_API_KEY",
      "WEB_PUSH_PRIVATE_KEY", "CALIBRATE_DIAGNOSTICS_METRICS_TOKEN"
    ], key) && can(regex("^[1-9][0-9]*$", version))])
    error_message = "Select explicit numeric versions of the documented app secrets."
  }
}
variable "alert_email" {
  type        = string
  default     = ""
  description = "Operator notification address; empty leaves notification delivery unconfigured."
}
variable "billing_account" {
  type        = string
  default     = ""
  description = "Billing account ID for an optional project-filtered budget. This does not link billing."
}
