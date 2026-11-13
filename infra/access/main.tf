# main.tf

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github"
  display_name              = "GitHub Actions"

  depends_on = [google_project_service.bootstrap]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-oidc"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
  }

  attribute_condition = "assertion.repository == \"${var.github_repo}\""
}

resource "google_service_account" "github_deployer" {
  account_id   = "github-deployer"
  display_name = "Déploiement depuis GitHub Actions"

  depends_on = [google_project_service.bootstrap]
}

resource "google_service_account_iam_member" "github_deployer_wif" {
  service_account_id = google_service_account.github_deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repo}"
}

# Accès au state : sur le bucket uniquement
resource "google_storage_bucket_iam_member" "github_deployer_state" {
  bucket = var.state_bucket
  role   = "roles/storage.objectAdmin"
  member = google_service_account.github_deployer.member
}

# Création du réseau : sur le projet
resource "google_project_iam_member" "github_deployer_network" {
  project = var.project_id
  role    = "roles/compute.networkAdmin"
  member  = google_service_account.github_deployer.member
}


# Lecture seule sur le projet : nécessaire au `terraform plan` (refresh des ressources)
resource "google_project_iam_member" "github_deployer_viewer" {
  project = var.project_id
  role    = "roles/viewer"
  member  = google_service_account.github_deployer.member
}

# Lecture des politiques IAM (projet, comptes de service) : `plan` de la stack access
resource "google_project_iam_member" "github_deployer_security_reviewer" {
  project = var.project_id
  role    = "roles/iam.securityReviewer"
  member  = google_service_account.github_deployer.member
}

# Pub/Sub : la CI doit pouvoir créer topics, souscriptions et leurs droits IAM
resource "google_project_iam_member" "github_deployer_pubsub" {
  project = var.project_id
  role    = "roles/pubsub.admin"
  member  = google_service_account.github_deployer.member
}

# GKE : la CI doit pouvoir créer le cluster et ses node pools
resource "google_project_iam_member" "github_deployer_container" {
  project = var.project_id
  role    = "roles/container.admin"
  member  = google_service_account.github_deployer.member
}

# GKE : attacher un compte de service aux nodes du cluster
resource "google_project_iam_member" "github_deployer_sa_user" {
  project = var.project_id
  role    = "roles/iam.serviceAccountUser"
  member  = google_service_account.github_deployer.member
}

# Activation des APIs (container.googleapis.com, ...) depuis Terraform
resource "google_project_iam_member" "github_deployer_service_usage" {
  project = var.project_id
  role    = "roles/serviceusage.serviceUsageAdmin"
  member  = google_service_account.github_deployer.member
}

# Pub/Sub : mon compte, pour lire et poser les droits IAM des topics
resource "google_project_iam_member" "alexis_pubsub" {
  project = var.project_id
  role    = "roles/pubsub.admin"
  member  = var.admin_member

  depends_on = [google_project_service.bootstrap]
}

# Secret Manager : la CI doit pouvoir créer les secrets et poser leurs droits d'accès
resource "google_project_iam_member" "github_deployer_secretmanager" {
  project = var.project_id
  role    = "roles/secretmanager.admin"
  member  = google_service_account.github_deployer.member
}

# Secret Manager : mon compte, pour poser les droits d'accès des secrets (editor ne le permet pas)
resource "google_project_iam_member" "alexis_secretmanager" {
  project = var.project_id
  role    = "roles/secretmanager.admin"
  member  = var.admin_member

  depends_on = [google_project_service.bootstrap]
}

# Firestore : la CI doit pouvoir créer la base (editor ne le permet pas)
resource "google_project_iam_member" "github_deployer_datastore" {
  project = var.project_id
  role    = "roles/datastore.owner"
  member  = google_service_account.github_deployer.member
}

# Firestore : mon compte, pour créer la base en local (editor ne le permet pas)
resource "google_project_iam_member" "alexis_datastore" {
  project = var.project_id
  role    = "roles/datastore.owner"
  member  = var.admin_member

  depends_on = [google_project_service.bootstrap]
}

# Firebase : mon compte, pour créer le projet Firebase et le site Hosting en local (editor ne le permet pas)
resource "google_project_iam_member" "alexis_firebase" {
  project = var.project_id
  role    = "roles/firebase.admin"
  member  = var.admin_member

  depends_on = [google_project_service.bootstrap]
}

# Stack serverless déployée par la CI : un rôle par famille de ressources qu'elle crée.
# Attention : roles/resourcemanager.projectIamAdmin permet de se donner n'importe quel autre rôle du projet.
# C'est le prix de « la CI applique les droits IAM des fonctions » ; à resserrer si la stack n'a plus à poser d'IAM.
locals {
  github_deployer_serverless_roles = toset([
    "roles/run.admin",                       # services Cloud Run des fonctions et leurs droits d'appel
    "roles/cloudfunctions.admin",            # fonctions gen2
    "roles/apigateway.admin",                # API, config et gateway
    "roles/serviceusage.apiKeysAdmin",       # clé API
    "roles/firebaserules.admin",             # règles Firestore
    "roles/storage.admin",                   # bucket des sources des fonctions
    "roles/firebase.admin",                  # projet Firebase et site Hosting (stack frontend, et envoi du site)
    "roles/iam.serviceAccountAdmin",         # un compte de service par fonction
    "roles/resourcemanager.projectIamAdmin", # rôles des comptes de service
  ])
}

resource "google_project_iam_member" "github_deployer_serverless" {
  for_each = local.github_deployer_serverless_roles

  project = var.project_id
  role    = each.value
  member  = google_service_account.github_deployer.member
}
