# Infrastructure state contains generated database/session credentials; use the private bootstrap bucket.
terraform {
  required_version = ">= 1.9, < 2.0"
  backend "gcs" {}
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 7.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }
}

provider "google" {
  project               = var.project_id
  region                = var.region
  user_project_override = true
  billing_project       = var.project_id
}
provider "google-beta" {
  project               = var.project_id
  region                = var.region
  user_project_override = true
  billing_project       = var.project_id
}

data "google_project" "app" {
  project_id = var.project_id
  lifecycle {
    postcondition {
      condition     = self.number == var.project_number
      error_message = "Project number differs from the operator-selected Calibrate project."
    }
  }
}
