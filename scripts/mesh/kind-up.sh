#!/usr/bin/env bash
# Creates the local kind cluster, installs Istio (demo profile) and its
# observability addons (Kiali, Prometheus, Grafana, Jaeger), and labels the
# stock-mesh namespace for automatic sidecar injection.
#
# Idempotent-ish: re-running after teardown.sh works; re-running against an
# already-up cluster is safe (kind/istioctl/kubectl apply all no-op cleanly).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLUSTER_NAME="stock-mesh"

echo "==> Checking required tools"
for bin in kind kubectl docker; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "ERROR: '$bin' is required but not found on PATH." >&2
    exit 1
  fi
done

if ! command -v istioctl >/dev/null 2>&1; then
  echo "==> istioctl not found"
  if command -v brew >/dev/null 2>&1; then
    echo "==> Installing istioctl via Homebrew"
    brew install istioctl
  else
    cat >&2 <<EOF
ERROR: istioctl not found and Homebrew isn't available to install it.
Install it manually: https://istio.io/latest/docs/setup/getting-started/#download
EOF
    exit 1
  fi
fi

echo "==> Creating kind cluster '$CLUSTER_NAME' (if it doesn't already exist)"
if kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME"; then
  echo "    cluster already exists, skipping"
else
  cat <<EOF | kind create cluster --name "$CLUSTER_NAME" --config -
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    extraPortMappings:
      - containerPort: 30080
        hostPort: 8080
        protocol: TCP
      - containerPort: 30443
        hostPort: 8443
        protocol: TCP
EOF
fi

kubectl config use-context "kind-$CLUSTER_NAME"

ISTIO_VERSION="$(istioctl version --remote=false -o json | python3 -c 'import json,sys; print(json.load(sys.stdin)["clientVersion"]["version"])')"
echo "==> Installing Istio $ISTIO_VERSION (demo profile)"
istioctl install --set profile=demo -y

echo "==> Exposing the ingress gateway on the kind node's mapped ports (30080/30443)"
# Patched by name (not array index) since the demo profile's port ordering
# isn't guaranteed across Istio versions.
kubectl get service istio-ingressgateway -n istio-system -o json | python3 -c '
import json, sys
svc = json.load(sys.stdin)
svc["spec"]["type"] = "NodePort"
targets = {"http2": 30080, "https": 30443}
for port in svc["spec"]["ports"]:
    if port.get("name") in targets:
        port["nodePort"] = targets[port["name"]]
json.dump(svc, sys.stdout)
' | kubectl apply -f -

echo "==> Installing observability addons (Kiali, Prometheus, Grafana, Jaeger)"
ADDONS_BASE="https://raw.githubusercontent.com/istio/istio/release-${ISTIO_VERSION%.*}/samples/addons"
for addon in prometheus grafana jaeger kiali; do
  kubectl apply -f "$ADDONS_BASE/$addon.yaml"
done
kubectl rollout status deployment/kiali -n istio-system --timeout=180s

echo "==> Creating and labeling the stock-mesh namespace"
kubectl apply -f "$REPO_ROOT/deploy/k8s/namespace.yaml"

echo "==> Done. Next: scripts/mesh/build-and-load.sh"
