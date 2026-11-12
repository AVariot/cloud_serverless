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
