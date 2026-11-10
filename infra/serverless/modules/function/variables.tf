# variables.tf

variable "project_id" {
  description = "ID du projet GCP"
  type        = string
}

variable "region" {
  description = "Région de déploiement"
  type        = string
}

variable "name" {
  description = "Nom de la fonction (aussi utilisé pour son compte de service : <name>-fn-sa)"
  type        = string
}

variable "source_dir" {
  description = "Dossier contenant le code de la fonction"
  type        = string
}

variable "entry_point" {
  description = "Nom de la fonction enregistrée dans le code (functions.HTTP)"
  type        = string
}

variable "source_bucket" {
  description = "Bucket qui reçoit le zip du code"
  type        = string
}

variable "runtime" {
  description = "Runtime Cloud Run functions"
  type        = string
  default     = "go127"
}

variable "memory" {
  description = "Mémoire allouée à la fonction"
  type        = string
  default     = "256M"
}

variable "timeout_seconds" {
  description = "Durée maximale d'une exécution"
  type        = number
  default     = 60
}

variable "env" {
  description = "Variables d'environnement de la fonction"
  type        = map(string)
  default     = {}
}

variable "secret_env" {
  description = "Secrets exposés en variables d'environnement : nom de la variable => secret_id dans Secret Manager"
  type        = map(string)
  default     = {}
}
