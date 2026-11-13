# variable.tf

variable "project_id" {
  type        = string
  description = "Project id from google cloud"
}

variable "region" {
  type        = string
  description = "Project deployed"
}

variable "cors_allowed_origins" {
  description = "Adresses des fronts autorisées à appeler /draw depuis un navigateur (liste vide = CORS fermé)"
  type        = list(string)
  default     = []
}

variable "discord_public_key" {
  description = "Clé publique (64 caractères hexadécimaux) de l'application Discord de cet environnement ; vide = à saisir à la main dans Secret Manager"
  type        = string
  default     = ""

  validation {
    condition     = var.discord_public_key == "" || can(regex("^[0-9a-f]{64}$", var.discord_public_key))
    error_message = "discord_public_key doit faire 64 caractères hexadécimaux en minuscules."
  }
}
