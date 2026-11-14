# variable.tf

variable "project_id" {
  type        = string
  description = "Project id from google cloud"
}

variable "region" {
  type        = string
  description = "Project deployed"
}

variable "vpc_name" {
  type        = string
  description = "Name of the VPC network."
}

variable "cidr_block" {
  type = string
}

variable "zone" {
  type        = string
  description = "Zone of the GKE cluster (inside region)"
}

variable "pods_cidr" {
  type        = string
  description = "Secondary range of the subnet used for GKE pod IPs"
}

variable "services_cidr" {
  type        = string
  description = "Secondary range of the subnet used for GKE service IPs"
}

variable "master_cidr" {
  type        = string
  description = "/28 range reserved for the GKE control plane"
}

variable "cluster_name" {
  type        = string
  description = "Name of the GKE cluster"
}

variable "node_service_account" {
  type        = string
  description = "Email of the node service account, created in the access stack"
}

variable "system_machine_type" {
  type        = string
  description = "Machine type of the always-on system node"
  default     = "e2-medium"
}

variable "runner_machine_type" {
  type        = string
  description = "Machine type of the runner nodes"
  default     = "e2-standard-2"
}

variable "runner_max_nodes" {
  type        = number
  description = "Upper bound of the runner pool autoscaling (cost safeguard)"
  default     = 3
}
