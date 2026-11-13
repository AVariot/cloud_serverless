# apis.tf

# API nécessaires aux fonctions et à la gateway.
# Un projet neuf ne les a pas : sans cette liste, il fallait les activer à la main avant le premier apply
# (c'était le cas de prd). pubsub, firestore, firebaserules et secretmanager sont activés dans leurs fichiers.
# L'activation est idempotente : sur un projet où elles sont déjà actives (dev), rien ne change.
locals {
  required_apis = toset([
    "run.googleapis.com",
    "cloudfunctions.googleapis.com",
    "cloudbuild.googleapis.com",
    "artifactregistry.googleapis.com",
    "apigateway.googleapis.com",
    "apikeys.googleapis.com",
    "servicecontrol.googleapis.com",
    "servicemanagement.googleapis.com",
  ])
}

resource "google_project_service" "apis" {
  for_each = local.required_apis

  service            = each.value
  disable_on_destroy = false
}
