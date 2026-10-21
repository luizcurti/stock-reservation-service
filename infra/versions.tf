terraform {
  # 1.10+ for the S3 backend's native lockfile (use_lockfile), used by the CI/CD deploy job.
  required_version = ">= 1.10"

  # No backend block on purpose: the CI deploy and Destroy workflows write ci_backend.tf with
  # `backend "s3" {}` right before `terraform init`, pointing at the bucket created by
  # ../bootstrap. Local runs (fmt/validate) use local state.

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = var.project_name
      ManagedBy = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name    = var.project_name
  account = data.aws_caller_identity.current.account_id
  azs     = slice(data.aws_availability_zones.available.names, 0, 2)
}
