# main.tf

resource "google_compute_network" "main" {
  name                    = var.vpc_name
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "main" {
  name          = "${var.vpc_name}-subnet"
  network       = google_compute_network.main.id
  ip_cidr_range = var.cidr_block
  region        = var.region

  # private nodes have no public IP: let them reach Google APIs (image pulls, logging)
  private_ip_google_access = true

  # extra IP ranges for the GKE cluster (VPC-native): one for pods, one for services
  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = var.pods_cidr
  }

  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = var.services_cidr
  }
}

# Cloud NAT: outbound internet for private nodes (runners must reach github.com)
resource "google_compute_router" "main" {
  name    = "${var.vpc_name}-router"
  network = google_compute_network.main.id
  region  = var.region
}

resource "google_compute_router_nat" "main" {
  name                               = "${var.vpc_name}-nat"
  router                             = google_compute_router.main.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}

output "vpc_id" {
  value       = google_compute_network.main.id
  description = "The id of the created VPC network"
}
