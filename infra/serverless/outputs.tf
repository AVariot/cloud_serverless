# outputs.tf

output "gateway_url" {
  description = "URL publique de l'API"
  value       = "https://${google_api_gateway_gateway.pixel.default_hostname}"
}

output "api_key" {
  description = "Clé API à passer dans le header x-api-key"
  value       = google_apikeys_key.pixel.key_string
  sensitive   = true
}
