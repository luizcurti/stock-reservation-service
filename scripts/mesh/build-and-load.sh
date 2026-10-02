#!/usr/bin/env bash
# Builds the service images and loads them into the kind cluster's node —
# kind clusters can't see the host Docker daemon's image cache, so a plain
# `docker build` alone would leave the cluster unable to pull them.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLUSTER_NAME="stock-mesh"

build() {
  local name="$1" context="$2"
  echo "==> Building $name:v1"
  docker build -t "$name:v1" "$context"
  echo "==> Loading $name:v1 into kind cluster '$CLUSTER_NAME'"
  kind load docker-image "$name:v1" --name "$CLUSTER_NAME"
}

# stock-service:v1 backs BOTH the v1 and v2 Deployments (see
# deploy/k8s/stock-service.yaml) — they differ only by the SERVICE_VERSION
# env var, not by image, so there is only one image to build here.
build stock-service "$REPO_ROOT/services/stock-service"
build order-service "$REPO_ROOT/services/order-service"
build payment-service "$REPO_ROOT/services/payment-service"

echo "==> Done. Next: scripts/mesh/deploy.sh"
