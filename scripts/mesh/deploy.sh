#!/usr/bin/env bash
# Applies the k8s manifests, the MySQL init-schema ConfigMap (generated from
# the single source of truth in services/stock-service/SQL, not duplicated
# into YAML), and the baseline Istio config (everything except deploy/istio/demo,
# which is only applied transiently by demo-resilience.sh).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "==> Applying namespace"
kubectl apply -f "$REPO_ROOT/deploy/k8s/namespace.yaml"

echo "==> Generating mysql-init ConfigMap from services/stock-service/SQL/stock.sql"
kubectl create configmap mysql-init \
  --from-file=init.sql="$REPO_ROOT/services/stock-service/SQL/stock.sql" \
  --namespace stock-mesh \
  --dry-run=client -o yaml | kubectl apply -f -

echo "==> Applying k8s workloads"
kubectl apply -f "$REPO_ROOT/deploy/k8s/mysql.yaml"
kubectl apply -f "$REPO_ROOT/deploy/k8s/stock-service.yaml"
kubectl apply -f "$REPO_ROOT/deploy/k8s/order-service.yaml"
kubectl apply -f "$REPO_ROOT/deploy/k8s/payment-service.yaml"

echo "==> Waiting for MySQL to be ready (schema init runs on first boot)"
kubectl rollout status deployment/mysql -n stock-mesh --timeout=180s

echo "==> Applying baseline Istio config (mTLS, canary split, retries/timeouts, gateway)"
kubectl apply -f "$REPO_ROOT/deploy/istio/peer-authentication.yaml"
kubectl apply -f "$REPO_ROOT/deploy/istio/destinationrule-stock.yaml"
kubectl apply -f "$REPO_ROOT/deploy/istio/destinationrule-payment.yaml"
kubectl apply -f "$REPO_ROOT/deploy/istio/virtualservice-stock.yaml"
kubectl apply -f "$REPO_ROOT/deploy/istio/virtualservice-order.yaml"
kubectl apply -f "$REPO_ROOT/deploy/istio/virtualservice-payment.yaml"
kubectl apply -f "$REPO_ROOT/deploy/istio/gateway.yaml"

echo "==> Waiting for app workloads to roll out"
kubectl rollout status deployment/stock-service-v1 -n stock-mesh --timeout=180s
kubectl rollout status deployment/stock-service-v2 -n stock-mesh --timeout=180s
kubectl rollout status deployment/order-service -n stock-mesh --timeout=180s
kubectl rollout status deployment/payment-service -n stock-mesh --timeout=180s

echo "==> Done. Try:"
echo "    curl -H 'Host: order-service.stock-mesh.svc.cluster.local' -X POST http://localhost:8080/orders \\"
echo "      -H 'Content-Type: application/json' -d '{\"productId\":1}'"
echo "    scripts/mesh/demo-canary.sh"
