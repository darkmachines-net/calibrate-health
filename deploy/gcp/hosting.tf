# Firebase owns HTTPS routing and credential verification; SQL still gates consent and Calibrate account access.
locals {
  firebase_social_signin_enabled = length(setintersection(
    toset([for provider in split(",", lookup(var.application_environment, "FIREBASE_SOCIAL_PROVIDERS", "")) : trimspace(provider)]),
    toset(["google.com", "apple.com"])
  )) > 0
}

resource "google_firebase_project" "app" {
  provider = google-beta
  project  = data.google_project.app.project_id
}
resource "google_firebase_hosting_site" "app" {
  provider   = google-beta
  project    = data.google_project.app.project_id
  site_id    = var.project_id
  depends_on = [google_firebase_project.app]
}
resource "google_firebase_web_app" "auth" {
  count        = var.auth_provider == "firebase" ? 1 : 0
  provider     = google-beta
  project      = data.google_project.app.project_id
  display_name = "Calibrate authentication"
  depends_on   = [google_firebase_project.app]
}
data "google_firebase_web_app_config" "auth" {
  count      = var.auth_provider == "firebase" ? 1 : 0
  provider   = google-beta
  project    = data.google_project.app.project_id
  web_app_id = google_firebase_web_app.auth[0].app_id
}
resource "google_identity_platform_config" "auth" {
  count              = var.auth_provider == "firebase" ? 1 : 0
  project            = data.google_project.app.project_id
  authorized_domains = distinct([trimprefix(var.public_origin, "https://"), "${var.project_id}.firebaseapp.com", "${var.project_id}.web.app"])
  sign_in {
    allow_duplicate_emails = false
    anonymous { enabled = false }
    phone_number { enabled = false }
    email {
      enabled           = true
      password_required = true
    }
  }
  client {
    permissions {
      # signInWithIdp creates provider identities; only Calibrate's consent-gated SQL binding grants application access.
      disabled_user_signup = !local.firebase_social_signin_enabled
      # Remote deletion must still follow Calibrate's durable deletion intent and credential revocation.
      disabled_user_deletion = true
    }
  }
  depends_on = [google_firebase_project.app]
  lifecycle { prevent_destroy = true }
}
resource "google_firebase_hosting_custom_domain" "app" {
  count         = var.custom_domain == "" ? 0 : 1
  provider      = google-beta
  project       = data.google_project.app.project_id
  site_id       = google_firebase_hosting_site.app.site_id
  custom_domain = var.custom_domain
}
