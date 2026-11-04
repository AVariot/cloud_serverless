# main.tf

resource "google_storage_bucket" "functions_src" {
  name                        = "${var.project_id}-functions-src"
  location                    = var.region
  uniform_bucket_level_access = true
}

module "proxy" {
  source = "./modules/function"

  project_id    = var.project_id
  region        = var.region
  name          = "proxy"
  entry_point   = "Proxy"
  source_dir    = "${path.module}/../../app/functions/proxy"
  source_bucket = google_storage_bucket.functions_src.name

  env = {
    GCP_PROJECT = var.project_id
    TOPIC_NAME  = google_pubsub_topic.pixel_events.name
  }
}

resource "google_pubsub_topic_iam_member" "proxy_publisher" {
  topic  = google_pubsub_topic.pixel_events.id
  role   = "roles/pubsub.publisher"
  member = module.proxy.service_account_member
}

# Identite de la gateway
resource "google_service_account" "gateway" {
  account_id   = "gateway-sa"
  display_name = "Identité de l'API Gateway"
}

# Gateway invoke le proxy
resource "google_cloud_run_v2_service_iam_member" "gateway_invokes_proxy" {
  project  = var.project_id
  location = var.region
  name     = module.proxy.name
  role     = "roles/run.invoker"
  member   = google_service_account.gateway.member
}
