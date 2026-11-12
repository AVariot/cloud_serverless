# secrets.tf

resource "google_project_service" "secretmanager" {
  service            = "secretmanager.googleapis.com"
  disable_on_destroy = false
}

resource "google_secret_manager_secret" "discord_public_key" {
  secret_id = "discord-public-key"

  replication {
    auto {
    }
  }

  depends_on = [google_project_service.secretmanager]
}
