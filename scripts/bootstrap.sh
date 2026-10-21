#!/usr/bin/env bash
# One-time setup for the CI/CD deploy job, in one command:
#   1. applies bootstrap/ (Terraform state bucket + GitHub OIDC deploy role) with YOUR AWS
#      credentials (admin), and
#   2. creates the `production` GitHub environment and writes AWS_DEPLOY_ROLE_ARN,
#      TF_STATE_BUCKET and AWS_REGION into it from the bootstrap outputs.
#
# Requirements: terraform >= 1.10, the AWS CLI credentials of the target account, and the
# GitHub CLI logged in with admin access to this repository (`gh auth login`).
#
# Usage:
#   scripts/bootstrap.sh                              # region eu-west-2, reuse the OIDC provider
#   scripts/bootstrap.sh -var="aws_region=eu-west-1"  # extra args go to `terraform apply`
#   scripts/bootstrap.sh -var="create_oidc_provider=true"   # account without the GitHub OIDC provider
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bootstrap_dir="$root_dir/bootstrap"

for cmd in terraform aws gh; do
  command -v "$cmd" >/dev/null || { echo "error: $cmd is not installed" >&2; exit 1; }
done

cd "$root_dir"
repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
repo_id="$(gh api "repos/$repo" --jq .id)"
owner_id="$(gh api "repos/$repo" --jq .owner.id)"
environment="production"

echo "AWS account: $(aws sts get-caller-identity --query Account --output text)"
echo "GitHub repo: $repo (environment: $environment)"
echo

terraform -chdir="$bootstrap_dir" init -input=false
terraform -chdir="$bootstrap_dir" apply \
  -var="github_repository=$repo" \
  -var="github_repository_id=$repo_id" \
  -var="github_owner_id=$owner_id" \
  "$@"

echo
echo "Configuring the '$environment' environment on GitHub..."
gh api --method PUT "repos/$repo/environments/$environment" >/dev/null

for name in AWS_DEPLOY_ROLE_ARN TF_STATE_BUCKET AWS_REGION; do
  value="$(terraform -chdir="$bootstrap_dir" output -raw "$name")"
  gh variable set "$name" --env "$environment" --repo "$repo" --body "$value"
  echo "  $name=$value"
done

echo
echo "Done. Deploy with: gh workflow run ci.yml --repo $repo --ref main"
