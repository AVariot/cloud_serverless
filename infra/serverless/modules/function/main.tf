# main.tf

locals {
  sa_id = "${var.name}-fn-sa"
}

# Identité d'exécution dédiée : par défaut elle n'a aucun droit
resource "google_service_account" "this" {
  account_id   = local.sa_id
  display_name = "Identité d'exécution de la fonction ${var.name}"
}

# Droit commun à toutes les fonctions : écrire des logs
resource "google_project_iam_member" "log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = google_service_account.this.member
}

# Zip du code (cmd/ ne sert qu'au lancement local, les tests n'ont rien à faire en production)
data "archive_file" "src" {
  type        = "zip"
  source_dir  = var.source_dir
  output_path = "${path.root}/.build/${var.name}.zip"
  excludes    = ["cmd", "*_test.go"]
}

# Upload du zip : le nom change avec le contenu, ce qui force un redéploiement
resource "google_storage_bucket_object" "src" {
  name   = "${var.name}-${data.archive_file.src.output_md5}.zip"
  bucket = var.source_bucket
  source = data.archive_file.src.output_path
}

# La fonction (Cloud Run functions gen2), privée : aucun invoker public
resource "google_cloudfunctions2_function" "this" {
  name     = var.name
  location = var.region

  build_config {
    runtime     = var.runtime
    entry_point = var.entry_point
    source {
      storage_source {
        bucket = var.source_bucket
        object = google_storage_bucket_object.src.name
      }
    }
  }

  service_config {
    service_account_email = google_service_account.this.email
    available_memory      = var.memory
    timeout_seconds       = var.timeout_seconds
    environment_variables = var.env

    # Secrets lus par la plateforme avec l'identité de la fonction (le droit d'accès est donné à part)
    dynamic "secret_environment_variables" {
      for_each = var.secret_env
      content {
        key        = secret_environment_variables.key
        project_id = var.project_id
        secret     = secret_environment_variables.value
        version    = "latest"
      }
    }
  }
}
