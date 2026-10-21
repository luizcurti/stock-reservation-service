#!/usr/bin/env bash
# End-to-end check of the AWS deployment, run by the CI deploy job after every
# deploy (and runnable by hand). Everything goes through the public URL, where
# the ALB routes /orders to order-service, /payments to payment-service and
# the rest to stock-service:
#   1. the API collection's stock-service and order-service folders (the
#      payment-service folder asserts payment-service's own /health, which the
#      shared URL routes to stock-service);
#   2. the point of the service: N concurrent orders against a product with
#      fewer units than orders must confirm exactly that many and never
#      oversell (order-service -> stock-service -> MySQL row locks ->
#      payment-service -> stock-service).
#
# Usage: API_URL=https://xxxx.cloudfront.net scripts/smoke-test.sh
set -euo pipefail

: "${API_URL:?set API_URL, e.g. https://xxxx.cloudfront.net}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() {
  echo "::error title=Smoke test::$*"
  echo "FAIL: $*" >&2
  exit 1
}

echo "== stock-service up"
for _ in $(seq 1 30); do
  curl -sf "$API_URL/health" > /dev/null && break
  sleep 5
done
curl -sf "$API_URL/health" || fail "GET /health did not answer 200"
echo

echo "== API collection"
npx --yes newman@6 run "$REPO_ROOT/collections/stock-reservation.postman_collection.json" \
  --env-var "stockUrl=$API_URL" \
  --env-var "orderUrl=$API_URL" \
  --env-var "paymentUrl=$API_URL" \
  --folder stock-service \
  --folder order-service \
  --reporters cli

units=3
orders=8
product=$((50000 + RANDOM))
echo "== $orders concurrent orders for product $product with $units units"
curl -sS -o /dev/null -X PATCH "$API_URL/product/$product/stock" \
  -H 'Content-Type: application/json' -d "{\"product\":\"Smoke Widget\",\"qtd\":$units}"

tmp=$(mktemp -d)
for i in $(seq 1 "$orders"); do
  curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$API_URL/orders" \
    -H 'Content-Type: application/json' -d "{\"productId\":$product}" > "$tmp/$i" &
done
wait
confirmed=$(cat "$tmp"/* | grep -c '^201$' || true)
echo "status codes: $(cat "$tmp"/* | sort | uniq -c | tr '\n' ' ')"
rm -rf "$tmp"

stock=$(curl -sS "$API_URL/product/$product")
echo "$stock"
[ "$confirmed" = "$units" ] || fail "$confirmed of $orders orders confirmed, expected exactly $units"
[ "$stock" = "{\"ID\":$product,\"IN_STOCK\":0,\"RESERVE\":0,\"SOLD\":$units}" ] ||
  fail "unexpected stock after the orders (oversold or reservation left behind): $stock"

echo "All smoke tests passed."
