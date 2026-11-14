# variable.tf

variable "project_id" {
  type        = string
  description = "Project id from google cloud"
}

variable "region" {
  type        = string
  description = "Project deployed"
}

variable "github_repo" {
  type        = string
  description = "Project deployed"
}

variable "state_bucket" {
  type        = string
  description = "Bucket name"
}

variable "admin_member" {
  type        = string
  description = "Admin email"
}
