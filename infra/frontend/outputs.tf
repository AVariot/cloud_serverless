# outputs.tf

output "site_id" {
  description = "Identifiant du site Firebase Hosting"
  value       = google_firebase_hosting_site.this.site_id
}

output "site_url" {
  description = "Adresse publique du front : à déclarer dans cors_allowed_origins (serverless) et dans les redirections OAuth2 de Discord"
  value       = "https://${google_firebase_hosting_site.this.site_id}.web.app"
}
