# output.tf

output "workload_identity_provider" {
  description = "Nom complet du provider, pour google-github-actions/auth"
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "deployer_service_account" {
  description = "Email du compte utilisé par la CI"
  value       = google_service_account.github_deployer.email
}
