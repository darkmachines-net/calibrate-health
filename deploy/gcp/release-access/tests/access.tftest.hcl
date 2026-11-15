# Trust and state-write boundaries are verified without using cloud credentials.
mock_provider "google" {
  mock_data "google_project" {
    defaults = { number = "234661857427", project_id = "calibrate-health" }
  }
}
run "isolated_terraform_identities" {
  command = plan
  assert {
    condition     = google_service_account.terraform["plan"].account_id != google_service_account.terraform["apply"].account_id && google_iam_workload_identity_pool.terraform["plan"].workload_identity_pool_id != google_iam_workload_identity_pool.terraform["apply"].workload_identity_pool_id
    error_message = "Planning and applying must have separate accounts and trust pools."
  }
  assert {
    condition = alltrue([for identity, environment in local.environments :
      google_iam_workload_identity_pool_provider.github[identity].attribute_condition == "assertion.repository_owner_id == '347558273' && assertion.repository_id == '1102078034' && assertion.repository == 'darkmachines-net/calibrate-health' && assertion.ref == 'refs/heads/master' && assertion.environment == '${environment}'"
    ])
    error_message = "Federation must retain immutable repository ownership, master and exact environment checks."
  }
  assert {
    condition     = google_storage_bucket_iam_member.state_write["plan"].condition[0].expression == "resource.name == '${local.lock_object}'" && google_storage_bucket_iam_member.state_read["plan"].condition[0].expression == "resource.name == '${local.state_object}'"
    error_message = "The planner may read application state and write its lock, but must not overwrite state."
  }
  assert {
    condition     = google_storage_bucket_iam_member.state_write["apply"].condition[0].expression == "resource.name in ['${local.state_object}', '${local.lock_object}']" && !strcontains(google_storage_bucket_iam_member.state_write["apply"].condition[0].expression, "release-access/")
    error_message = "The applier's direct state grant must exclude the operator's access state."
  }
  assert {
    condition     = alltrue([for role in local.project_roles.plan : !strcontains(lower(role), "admin") && !contains(["roles/owner", "roles/editor", "roles/iam.serviceAccountUser", "roles/iam.serviceAccountTokenCreator"], role)]) && !contains(google_project_iam_custom_role.budget["plan"].permissions, "billing.resourcebudgets.write")
    error_message = "Planning must not receive infrastructure mutation, impersonation or budget-write roles."
  }
  assert {
    condition     = contains(google_project_iam_custom_role.budget["apply"].permissions, "billing.resourcebudgets.write") && alltrue([for binding in google_service_account_iam_member.apply_runtime : binding.role == "roles/iam.serviceAccountUser"])
    error_message = "Apply needs only project-scoped budget permissions and explicit runtime use grants."
  }
}
