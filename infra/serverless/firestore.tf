# firestore.tf

resource "google_project_service" "firestore" {
  service            = "firestore.googleapis.com"
  disable_on_destroy = false
}

resource "google_firestore_database" "main" {
  name        = "(default)"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"

  delete_protection_state = "DELETE_PROTECTION_DISABLED"
  deletion_policy         = "DELETE"

  depends_on = [google_project_service.firestore]
}

# Le front écoute seulement les chunks qu'il affiche : where chunk == "cx_cy" et updated_at > dernier snapshot.
# Firestore refuse une requête qui combine une égalité et un intervalle sans cet index composite.
resource "google_firestore_index" "pixels_chunk_updated_at" {
  database    = google_firestore_database.main.name
  collection  = "pixels"
  query_scope = "COLLECTION"

  fields {
    field_path = "chunk"
    order      = "ASCENDING"
  }

  fields {
    field_path = "updated_at"
    order      = "ASCENDING"
  }
}

# --- Lecture temps réel par le front ---------------------------------------------------------
# Le navigateur écoute seulement les chunks qu'il affiche (onSnapshot). Il LIT la collection pixels :
# toute écriture directe est refusée, elles passent toutes par la gateway puis la file (exigence du sujet).
# config/, ratelimits/ et tout le reste restent fermés.
resource "google_project_service" "firebaserules" {
  service            = "firebaserules.googleapis.com"
  disable_on_destroy = false
}

resource "google_firebaserules_ruleset" "firestore" {
  source {
    files {
      name    = "firestore.rules"
      content = <<-EOT
        rules_version = '2';
        service cloud.firestore {
          match /databases/{database}/documents {
            match /pixels/{pixel} {
              allow read: if true;
              allow write: if false;
            }
            match /{document=**} {
              allow read, write: if false;
            }
          }
        }
      EOT
    }
  }

  depends_on = [google_firestore_database.main, google_project_service.firebaserules]
}

resource "google_firebaserules_release" "firestore" {
  name         = "cloud.firestore"
  ruleset_name = google_firebaserules_ruleset.firestore.name
}
