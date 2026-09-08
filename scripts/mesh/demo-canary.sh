#!/usr/bin/env bash
# Proves the 90/10 traffic split defined in deploy/istio/virtualservice-stock.yaml
# by hitting stock-service through the ingress gateway N times and tallying
# the X-Version response header set by each pod (services/stock-service/app.ts).
set -euo pipefail

REQUESTS="${1:-50}"
GATEWAY_URL="http://localhost:8080"

echo "==> Sending $REQUESTS requests to stock-service via the ingress gateway"
echo "    (expect roughly 90% v1 / 10% v2 — small samples will vary)"

v1=0
v2=0
other=0

for i in $(seq 1 "$REQUESTS"); do
  version=$(curl -s -o /dev/null -D - -H "Host: stock-service.stock-mesh.svc.cluster.local" "$GATEWAY_URL/product/1" \
    | grep -i '^x-version:' | tr -d '\r' | awk '{print $2}')
  case "$version" in
    v1) v1=$((v1 + 1)) ;;
    v2) v2=$((v2 + 1)) ;;
    *) other=$((other + 1)) ;;
  esac
done

echo ""
echo "==> Results out of $REQUESTS requests:"
echo "    v1: $v1"
echo "    v2: $v2"
if [ "$other" -gt 0 ]; then
  echo "    no X-Version header (request failed?): $other"
fi
