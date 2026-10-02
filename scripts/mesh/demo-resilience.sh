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
#   Phase 2 — TIMEOUT: payment-service is set to CHAOS_MODE=slow with a 10s
#   delay — a genuinely slow upstream. Each attempt is cut at the 1s
#   perTryTimeout and the whole call at the 3s overall `timeout`, so orders
#   fail fast and predictably instead of waiting on payment-service. After
#   a few of those timeouts, outlier detection (destinationrule-payment.yaml)
#   ejects the slow pods and the remaining orders fail immediately.
#
# (Istio's fault-injection `delay` is deliberately NOT used for phase 2:
# Envoy applies it in a filter before the router, so the injected delay is
# neither retried nor counted against the route's timeout — a 5s injected
# delay against this 3s timeout simply answers after 5s.)
set -euo pipefail

GATEWAY_URL="http://localhost:8080"
REQUESTS="${1:-20}"
# A product of its own, restocked on every run — the seed products are small
# (50 units for product 1), so reusing one would eventually run it out of
# stock and every order would "fail" with a 400 that has nothing to do with
# retries or timeouts.
PRODUCT_ID=900

restock() {
  curl -s -o /dev/null -f -H "Host: stock-service.stock-mesh.svc.cluster.local" \
    -X PATCH "$GATEWAY_URL/product/$PRODUCT_ID/stock" \
    -H "Content-Type: application/json" \
    -d "{\"product\":\"Resilience Demo Widget\",\"qtd\":$((REQUESTS * 10))}"
}

fire_orders() {
  local succeeded=0 statuses="" timed_out=0 instant=0 result status seconds
  for _ in $(seq 1 "$REQUESTS"); do
    result=$(curl -s -o /dev/null -w '%{http_code} %{time_total}' -H "Host: order-service.stock-mesh.svc.cluster.local" \
      -X POST "$GATEWAY_URL/orders" \
      -H "Content-Type: application/json" \
      -d "{\"productId\":$PRODUCT_ID}")
    status=${result% *}
    seconds=${result#* }
    if [ "$status" = "201" ]; then
      succeeded=$((succeeded + 1))
    elif awk "BEGIN { exit !($seconds >= 2.5) }"; then
      timed_out=$((timed_out + 1))
    else
      instant=$((instant + 1))
    fi
    statuses="$statuses $status"
    printf '.'
  done
  echo ""
  echo "    $succeeded/$REQUESTS orders succeeded — HTTP statuses:$(echo "$statuses" | tr ' ' '\n' | sed '/^$/d' | sort | uniq -c | awk '{printf " %sx%s", $1, $2}')"
  if [ "$timed_out" -gt 0 ] || [ "$instant" -gt 0 ]; then
    echo "    of the failures: $timed_out cut off at the ~3s timeout, $instant failed in under 2.5s"
  fi
}

cleanup() {
  echo ""
  echo "==> Restoring baseline: CHAOS_MODE=off"
  kubectl set env deployment/payment-service -n stock-mesh CHAOS_MODE=off CHAOS_SLOW_MS- >/dev/null
  kubectl rollout status deployment/payment-service -n stock-mesh --timeout=60s >/dev/null
}
trap cleanup EXIT

echo "==> Restocking demo product $PRODUCT_ID"
restock

echo "=== Phase 1: retries absorbing a real, intermittent failure ==="
echo "==> Setting payment-service to CHAOS_MODE=flaky (~40% real 503s)"
kubectl set env deployment/payment-service -n stock-mesh CHAOS_MODE=flaky >/dev/null
kubectl rollout status deployment/payment-service -n stock-mesh --timeout=60s >/dev/null
echo "==> Firing $REQUESTS orders — Envoy retries each failed attempt (deploy/istio/virtualservice-payment.yaml)"
fire_orders

echo ""
echo "=== Phase 2: timeout bounding a slow dependency ==="
echo "==> Setting payment-service to CHAOS_MODE=slow, CHAOS_SLOW_MS=10000 (every payment takes 10s)"
kubectl set env deployment/payment-service -n stock-mesh CHAOS_MODE=slow CHAOS_SLOW_MS=10000 >/dev/null
kubectl rollout status deployment/payment-service -n stock-mesh --timeout=60s >/dev/null
echo "==> Firing $REQUESTS orders — none should wait the full 10s: the first few are cut off"
echo "    at the 3s timeout, then outlier detection ejects the slow pods"
echo "    (deploy/istio/destinationrule-payment.yaml) and the rest fail immediately"
fire_orders
