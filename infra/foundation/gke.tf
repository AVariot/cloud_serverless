# gke.tf

resource "google_project_service" "container" {
  service            = "container.googleapis.com"
  disable_on_destroy = false
}

resource "google_container_cluster" "main" {
  name     = var.cluster_name
  location = var.zone # a zone (not a region): zonal cluster, covered by the GKE free tier

  network    = google_compute_network.main.id
  subnetwork = google_compute_subnetwork.main.id

  # node pools are managed below; GKE requires a default pool at creation, so create it and remove it
  remove_default_node_pool = true
  initial_node_count       = 1

  # lets the pipeline destroy the cluster
  deletion_protection = false

  release_channel {
    channel = "REGULAR"
  }

  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }

  # nodes get no public IP; the control plane keeps a public endpoint for kubectl / helm
  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = false
    master_ipv4_cidr_block  = var.master_cidr
  }

  # lets pods use a GCP service account without keys (GKE Workload Identity)
  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  # remove idle nodes faster than the default profile
  cluster_autoscaling {
    autoscaling_profile = "OPTIMIZE_UTILIZATION"
  }

  depends_on = [google_project_service.container]
}

# Always-on pool for the cluster's own components (DNS, metrics) and the runner controller
resource "google_container_node_pool" "system" {
  name       = "system"
  cluster    = google_container_cluster.main.id
  location   = var.zone
  node_count = 1

  management {
    auto_repair  = true
    auto_upgrade = true
  }

  node_config {
    machine_type    = var.system_machine_type
    spot            = true
    disk_type       = "pd-standard"
    disk_size_gb    = 30
    service_account = var.node_service_account
    oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]

    workload_metadata_config {
      mode = "GKE_METADATA"
    }
  }
}

# Pool dedicated to the GitHub runners: scales from 0 nodes (no cost when idle) to runner_max_nodes
resource "google_container_node_pool" "runners" {
  name     = "runners"
  cluster  = google_container_cluster.main.id
  location = var.zone

  autoscaling {
    min_node_count = 0
    max_node_count = var.runner_max_nodes
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }

  node_config {
    machine_type    = var.runner_machine_type
    spot            = true
    disk_type       = "pd-standard"
    disk_size_gb    = 30
    service_account = var.node_service_account
    oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]

    labels = {
      workload = "runners"
    }

    # only pods that tolerate this taint (the runners) are scheduled here
    taint {
      key    = "workload"
      value  = "runners"
      effect = "NO_SCHEDULE"
    }

    workload_metadata_config {
      mode = "GKE_METADATA"
    }
  }
}

output "cluster_name" {
  value       = google_container_cluster.main.name
  description = "Name of the GKE cluster"
}

output "cluster_location" {
  value       = google_container_cluster.main.location
  description = "Zone of the GKE cluster"
}
