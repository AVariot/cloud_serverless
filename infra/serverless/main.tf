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
    GCP_PROJECT        = var.project_id
    TOPIC_NAME         = google_pubsub_topic.pixel_events.name
    DISCORD_TOPIC_NAME = google_pubsub_topic.discord_command.name
  }

  # Clé publique Discord : lue dans Secret Manager, jamais écrite dans le code ni dans le state
  secret_env = {
    DISCORD_PUBLIC_KEY = google_secret_manager_secret.discord_public_key.secret_id
  }
}

resource "google_pubsub_topic_iam_member" "proxy_publisher" {
  topic  = google_pubsub_topic.pixel_events.id
  role   = "roles/pubsub.publisher"
  member = module.proxy.service_account_member
}

# Le proxy publie aussi les commandes Discord, sur ce topic uniquement
resource "google_pubsub_topic_iam_member" "proxy_discord_publisher" {
  topic  = google_pubsub_topic.discord_command.id
  role   = "roles/pubsub.publisher"
  member = module.proxy.service_account_member
}

# Le proxy peut lire la clé publique Discord, et aucun autre secret
resource "google_secret_manager_secret_iam_member" "proxy_discord_public_key" {
  secret_id = google_secret_manager_secret.discord_public_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = module.proxy.service_account_member
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

# Api
resource "google_api_gateway_api" "pixel" {
  provider = google-beta
  api_id   = "pixel-api"
}

# Api Gateway Config
resource "google_api_gateway_api_config" "pixel" {
  provider             = google-beta
  api                  = google_api_gateway_api.pixel.api_id
  api_config_id_prefix = "pixel-config-"

  openapi_documents {
    document {
      path     = "pixel-api.yaml"
      contents = base64encode(templatefile("${path.module}/openapi/pixel-api.yaml.tftpl", { proxy_url = module.proxy.uri }))
    }
  }

  gateway_config {
    backend_config {
      google_service_account = google_service_account.gateway.email
    }
  }

  lifecycle {
    create_before_destroy = true
  }
}

# Gateway
resource "google_api_gateway_gateway" "pixel" {
  provider   = google-beta
  gateway_id = "pixel-gw"
  api_config = google_api_gateway_api_config.pixel.id
  region     = var.region
}

# Active le service géré propre à l'API (requis pour qu'une clé puisse le cibler)
resource "google_project_service" "pixel_api" {
  service            = google_api_gateway_api.pixel.managed_service
  disable_on_destroy = false
}

# Clé API restreinte à cette API uniquement
resource "google_apikeys_key" "pixel" {
  name         = "pixel-api-key"
  display_name = "Clé API pixel"

  restrictions {
    api_targets {
      service = google_api_gateway_api.pixel.managed_service
    }
  }

  depends_on = [google_project_service.pixel_api]
}
