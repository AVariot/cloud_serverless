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
