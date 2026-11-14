# gke.tf

# Identity of the GKE nodes: replaces the over-privileged default Compute service account
resource "google_service_account" "gke_nodes" {
  account_id   = "gke-nodes"
  display_name = "GKE cluster nodes (runners)"
}

# Minimum rights of a node: write logs and metrics, read metadata
resource "google_project_iam_member" "gke_nodes_default" {
  project = var.project_id
  role    = "roles/container.defaultNodeServiceAccount"
  member  = google_service_account.gke_nodes.member
}

output "gke_nodes_service_account" {
  value       = google_service_account.gke_nodes.email
  description = "Service account used by the GKE nodes (foundation stack)"
}
