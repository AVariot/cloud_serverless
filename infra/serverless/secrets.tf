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

# Valeur de la clé publique de l'application Discord (Discord Developer Portal, General Information).
# Elle est publique par nature (elle sert à vérifier les signatures) : elle peut être dans un fichier de variables.
# Vide : aucune version n'est créée et la valeur reste à saisir à la main.
resource "google_secret_manager_secret_version" "discord_public_key" {
  count = var.discord_public_key == "" ? 0 : 1

  secret      = google_secret_manager_secret.discord_public_key.id
  secret_data = var.discord_public_key
}
