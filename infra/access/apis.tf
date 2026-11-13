# apis.tf

# API dont dépend cette stack. Sur un projet neuf elles sont éteintes : sans cette liste, il fallait les activer
# à la main avant le premier apply (c'était le cas de prd). L'activation est idempotente.
# serviceusage est actif par défaut : c'est lui qui permet d'activer les autres.
locals {
  bootstrap_apis = toset([
    "iam.googleapis.com",                  # pool d'identités, fournisseur OIDC, comptes de service
    "iamcredentials.googleapis.com",       # jetons de courte durée du compte de service
    "sts.googleapis.com",                  # échange du jeton GitHub contre un accès GCP
    "cloudresourcemanager.googleapis.com", # rôles au niveau du projet
  ])
}

resource "google_project_service" "bootstrap" {
  for_each = local.bootstrap_apis

  service            = each.value
  disable_on_destroy = false
}
