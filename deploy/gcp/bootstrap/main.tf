# Enables APIs and creates protected remote state in an existing, explicitly selected project.
terraform {
  required_version = ">= 1.9, < 2.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }
}
variable "project_id" {
  type = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id)) && var.project_id != "little-say"
    error_message = "Select a dedicated Calibrate project, not Little Say."
  }
}
variable "project_number" {
  type = string
  validation {
    condition     = can(regex("^[0-9]+$", var.project_number)) && var.project_number != "1003645384869"
    error_message = "Supply the independently verified Calibrate project number."
  }
}
variable "region" {
  type    = string
  default = "us-central1"
}
provider "google" {
  project = var.project_id
}
data "google_project" "app" {
  project_id = var.project_id
  lifecycle {
    postcondition {
      condition     = self.number == var.project_number
      error_message = "Refusing bootstrap in an unexpected GCP project."
    }
  }
}
resource "google_project_service" "api" {
  for_each = toset([
    "serviceusage.googleapis.com", "cloudresourcemanager.googleapis.com", "iam.googleapis.com",
    "iamcredentials.googleapis.com", "sts.googleapis.com", "storage.googleapis.com",
    "firebase.googleapis.com", "firebasehosting.googleapis.com", "run.googleapis.com",
    "sqladmin.googleapis.com", "artifactregistry.googleapis.com", "secretmanager.googleapis.com",
    "monitoring.googleapis.com", "logging.googleapis.com", "billingbudgets.googleapis.com",
    "identitytoolkit.googleapis.com", "securetoken.googleapis.com", "apikeys.googleapis.com",
    "dns.googleapis.com"
  ])
  project            = data.google_project.app.project_id
  service            = each.value
  disable_on_destroy = false
}
resource "google_storage_bucket" "state" {
  project                     = data.google_project.app.project_id
  name                        = "${var.project_id}-tfstate-${var.project_number}"
  location                    = upper(var.region)
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  versioning {
    enabled = true
  }
  lifecycle {
    prevent_destroy = true
  }
  depends_on = [google_project_service.api]
}
output "state_bucket" {
  value = google_storage_bucket.state.name
}
