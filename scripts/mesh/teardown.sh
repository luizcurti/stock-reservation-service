#!/usr/bin/env bash
# Deletes the local kind cluster and everything in it. Nothing outside the
# cluster (images in the host Docker daemon, repo files) is touched.
set -euo pipefail

CLUSTER_NAME="stock-mesh"

if kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME"; then
  kind delete cluster --name "$CLUSTER_NAME"
else
  echo "No kind cluster named '$CLUSTER_NAME' found — nothing to do."
fi
