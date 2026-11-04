# outputs.tf

output "name" {
  description = "Nom de la fonction (et du service Cloud Run sous-jacent)"
  value       = google_cloudfunctions2_function.this.name
}

output "uri" {
  description = "URL du service Cloud Run (privée)"
  value       = google_cloudfunctions2_function.this.service_config[0].uri
}

output "service_account_email" {
  description = "Email du compte de service d'exécution"
  value       = google_service_account.this.email
}

output "service_account_member" {
  description = "Membre IAM (serviceAccount:...) pour accorder des droits supplémentaires"
  value       = google_service_account.this.member
}
