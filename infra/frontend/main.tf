# main.tf

# Hébergement du front : application statique (Vite + React, dossier app/frontend) servie par Firebase Hosting,
# qui fournit HTTPS et CDN sans serveur ni bucket public.
# Ce fichier crée le site. Les fichiers du front, eux, sont envoyés par la CI (voir terraform-deploy.yml) :
# Terraform ne sait pas déposer proprement un dossier construit à chaque version.

resource "google_project_service" "apis" {
  for_each = toset([
    "firebase.googleapis.com",
    "firebasehosting.googleapis.com",
  ])

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

# Rend le projet GCP visible dans Firebase (nécessaire pour Hosting) : il ne crée ni ne modifie rien d'autre.
resource "google_firebase_project" "this" {
  provider = google-beta
  project  = var.project_id

  depends_on = [google_project_service.apis]
}

# Site par défaut du projet : Firebase le crée en même temps que le projet Firebase, et son identifiant est celui
# du projet (adresse https://<project_id>.web.app, déjà unique dans le monde). On le déclare pour le gérer :
# sur un projet où il existe déjà, il faut l'importer (voir COMMANDS.md ou scripts/new_env.sh).
resource "google_firebase_hosting_site" "this" {
  provider = google-beta
  project  = var.project_id
  site_id  = var.project_id

  depends_on = [google_firebase_project.this]
}
