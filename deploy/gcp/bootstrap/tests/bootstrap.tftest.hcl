# Bootstrap is tested with a fake project and provider; no billing or service activation occurs.
mock_provider "google" {
  mock_data "google_project" {
    defaults = { number = "123456789012", project_id = "calibrate-test" }
  }
}
variables {
  project_id     = "calibrate-test"
  project_number = "123456789012"
}
run "private_versioned_state" {
  command = plan
  assert {
    condition     = google_storage_bucket.state.name == "calibrate-test-tfstate-123456789012" && google_storage_bucket.state.versioning[0].enabled
    error_message = "State must be project-specific and versioned."
  }
  assert {
    condition     = google_storage_bucket.state.public_access_prevention == "enforced" && google_storage_bucket.state.uniform_bucket_level_access && !google_storage_bucket.state.force_destroy
    error_message = "State must remain private and protected against forced deletion."
  }
  assert {
    condition     = alltrue([for api in ["identitytoolkit.googleapis.com", "securetoken.googleapis.com", "apikeys.googleapis.com"] : contains(keys(google_project_service.api), api)])
    error_message = "Bootstrap must enable the APIs needed by optional Firebase authentication."
  }
  assert {
    condition     = contains(keys(google_project_service.api), "dns.googleapis.com")
    error_message = "Bootstrap must enable optional authoritative Cloud DNS management."
  }
}
run "wrong_project" {
  command = plan
  variables {
    project_number = "987654321098"
  }
  expect_failures = [data.google_project.app]
}
