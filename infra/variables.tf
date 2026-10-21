variable "project_name" {
  description = "Prefix of every resource name. Must match project_name in ../bootstrap (the deploy role is scoped by it)."
  type        = string
  default     = "stock-res"
}

variable "aws_region" {
  description = "AWS region of the stack (CloudFront itself is global)."
  type        = string
  default     = "eu-west-2"
}

variable "app_image_tag" {
  description = "Tag of the three service images in ECR, pushed by the CI deploy job before apply (the commit SHA)."
  type        = string
  default     = "latest"
}

variable "mysql_client_image" {
  description = "Image of the one-off schema task (only its mysql client is used). Pulled from the ECR Public mirror of Docker Hub's official images."
  type        = string
  default     = "public.ecr.aws/docker/library/mysql:8.4"
}

variable "vpc_cidr" {
  description = "CIDR of the VPC. Two public /24 subnets are carved out of it."
  type        = string
  default     = "10.48.0.0/16"
}

variable "db_instance_class" {
  description = "RDS instance class. db.t4g.micro is free-tier eligible on new accounts."
  type        = string
  default     = "db.t4g.micro"
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for the container logs."
  type        = number
  default     = 14
}
