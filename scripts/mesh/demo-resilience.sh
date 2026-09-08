#!/usr/bin/env bash
# Proves the retry/timeout policies (deploy/istio/virtualservice-payment.yaml)
# actually do something against a degraded downstream, instead of just
# existing as YAML. Two phases, because they demonstrate two different knobs:
#
#   Phase 1 — RETRIES: payment-service is set to CHAOS_MODE=flaky, returning
#   a real 503 on ~40% of requests. These are genuine upstream failures, so
#   Envoy's retry policy actually retries them — most orders should still
#   succeed even though the dependency is visibly unhealthy.
#
#   Phase 2 — TIMEOUT: deploy/istio/demo/fault-injection-payment.yaml injects
#   a 5s delay on 60% of requests via Istio's fault-injection filter, which
#   runs BEFORE routing/retry logic and so is deliberately NOT retried (that's
#   how Envoy fault injection works — see the comment in that file). Against
#   the 3s overall `timeout`, this shows requests failing fast and
#   predictably instead of hanging indefinitely.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GATEWAY_URL="http://localhost:8080"
REQUESTS="${1:-20}"

fire_orders() {
  local succeeded=0 failed=0
  for i in $(seq 1 "$REQUESTS"); do
    status=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: order-service.stock-mesh.svc.cluster.local" \
      -X POST "$GATEWAY_URL/orders" \
      -H "Content-Type: application/json" \
      -d '{"productId":1}')
    if [ "$status" = "201" ]; then
      succeeded=$((succeeded + 1))
    else
      failed=$((failed + 1))
    fi
    printf '.'
  done
  echo ""
  echo "    $succeeded/$REQUESTS orders succeeded, $failed failed"
}

cleanup() {
  echo ""
  echo "==> Restoring baseline: CHAOS_MODE=off, clean payment-service VirtualService"
  kubectl set env deployment/payment-service -n stock-mesh CHAOS_MODE=off >/dev/null
  kubectl apply -f "$REPO_ROOT/deploy/istio/virtualservice-payment.yaml" >/dev/null
}
trap cleanup EXIT

echo "=== Phase 1: retries absorbing a real, intermittent failure ==="
echo "==> Setting payment-service to CHAOS_MODE=flaky (~40% real 503s)"
kubectl set env deployment/payment-service -n stock-mesh CHAOS_MODE=flaky >/dev/null
kubectl rollout status deployment/payment-service -n stock-mesh --timeout=60s >/dev/null
echo "==> Firing $REQUESTS orders — Envoy retries each failed attempt (deploy/istio/virtualservice-payment.yaml)"
fire_orders

echo ""
echo "=== Phase 2: timeout bounding a mesh-injected delay ==="
echo "==> Injecting a 5s delay on 60% of payment-service traffic (payment-service itself is healthy)"
kubectl set env deployment/payment-service -n stock-mesh CHAOS_MODE=off >/dev/null
kubectl apply -f "$REPO_ROOT/deploy/istio/demo/fault-injection-payment.yaml" >/dev/null
sleep 2 # let the Envoy proxies pick up the new config
echo "==> Firing $REQUESTS orders — delayed ones should fail fast at the 3s timeout, not hang"
fire_orders
