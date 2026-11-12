# main.tf

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github"
  display_name              = "GitHub Actions"
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
}

resource "google_service_account_iam_member" "github_deployer_wif" {
  service_account_id = google_service_account.github_deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repo}"
}

# Accès au state : sur le bucket uniquement
resource "google_storage_bucket_iam_member" "github_deployer_state" {
  bucket = "servtkt-cloudnative-dev-tfstate-eu"
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
  member  = "user:alexisvariot418@gmail.com"
}
