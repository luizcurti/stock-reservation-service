#!/usr/bin/env bash
# Integration test for the 3-service system running via docker-compose —
# exercises real HTTP calls across order-service -> stock-service ->
# payment-service, which no per-service test suite covers on its own.
# Run locally (`scripts/integration-test.sh`) or via the "docker" CI job
# (.github/workflows/ci.yml).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

STOCK_URL="http://localhost:3000"
ORDER_URL="http://localhost:3001"
PAYMENT_URL="http://localhost:3002"

PASS=0
FAIL=0

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  OK   $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $desc (expected '$expected', got '$actual')"
    FAIL=$((FAIL + 1))
  fi
}

cleanup() {
  local exit_code=$?
  if [ "$exit_code" -ne 0 ]; then
    echo ""
    echo "==> Failure detected — dumping container logs before teardown"
    docker compose logs || true
  fi
  echo ""
  echo "==> Tearing down"
  docker compose down -v >/dev/null 2>&1
  exit "$exit_code"
}
trap cleanup EXIT

echo "==> Starting the full stack (docker compose)"
if ! docker compose up -d --build >/tmp/integration-compose.log 2>&1; then
  echo "docker compose up failed:"
  cat /tmp/integration-compose.log
  exit 1
fi

echo "==> Waiting for all services to be healthy"
for i in $(seq 1 30); do
  s1=$(curl -s -o /dev/null -w '%{http_code}' "$STOCK_URL/health" 2>/dev/null)
  s2=$(curl -s -o /dev/null -w '%{http_code}' "$ORDER_URL/health" 2>/dev/null)
  s3=$(curl -s -o /dev/null -w '%{http_code}' "$PAYMENT_URL/health" 2>/dev/null)
  if [ "$s1" = "200" ] && [ "$s2" = "200" ] && [ "$s3" = "200" ]; then
    break
  fi
  sleep 2
done
assert_eq "stock-service healthy" "200" "$s1"
assert_eq "order-service healthy" "200" "$s2"
assert_eq "payment-service healthy" "200" "$s3"

echo ""
echo "=== Test 1: happy path (reserve -> pay -> confirm) ==="
curl -s -X PATCH "$STOCK_URL/product/100/stock" -H "Content-Type: application/json" \
  -d '{"product":"Integration Widget","qtd":5}' >/dev/null
order_status=$(curl -s -o /tmp/order1.json -w '%{http_code}' -X POST "$ORDER_URL/orders" \
  -H "Content-Type: application/json" -d '{"productId":100}')
assert_eq "order confirmed (201)" "201" "$order_status"
order_body=$(cat /tmp/order1.json)
assert_eq "order status is confirmed" "confirmed" "$(echo "$order_body" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))' 2>/dev/null)"
stock_after=$(curl -s "$STOCK_URL/product/100")
assert_eq "stock decremented, sale recorded" '{"ID":100,"IN_STOCK":4,"RESERVE":0,"SOLD":1}' "$stock_after"

echo ""
echo "=== Test 2: payment decline releases the reservation ==="
curl -s -X PATCH "$STOCK_URL/product/101/stock" -H "Content-Type: application/json" \
  -d '{"product":"Decline Widget","qtd":5}' >/dev/null
CHAOS_MODE=fail docker compose up -d payment-service >/tmp/integration-compose.log 2>&1
for i in $(seq 1 15); do
  s=$(curl -s -o /dev/null -w '%{http_code}' "$PAYMENT_URL/health")
  [ "$s" = "200" ] && break
  sleep 1
done
order2_status=$(curl -s -o /tmp/order2.json -w '%{http_code}' -X POST "$ORDER_URL/orders" \
  -H "Content-Type: application/json" -d '{"productId":101}')
assert_eq "order rejected (not 201) when payment is down" "false" "$([ "$order2_status" = "201" ] && echo true || echo false)"
stock_after2=$(curl -s "$STOCK_URL/product/101")
assert_eq "reservation released back to stock" '{"ID":101,"IN_STOCK":5,"RESERVE":0,"SOLD":0}' "$stock_after2"

CHAOS_MODE=off docker compose up -d payment-service >/tmp/integration-compose.log 2>&1
for i in $(seq 1 15); do
  s=$(curl -s -o /dev/null -w '%{http_code}' "$PAYMENT_URL/health")
  [ "$s" = "200" ] && break
  sleep 1
done

echo ""
echo "=== Test 3: insufficient stock is surfaced through order-service ==="
curl -s -X PATCH "$STOCK_URL/product/102/stock" -H "Content-Type: application/json" \
  -d '{"product":"Scarce Widget","qtd":1}' >/dev/null
curl -s -X POST "$ORDER_URL/orders" -H "Content-Type: application/json" -d '{"productId":102}' >/dev/null
order3_status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$ORDER_URL/orders" \
  -H "Content-Type: application/json" -d '{"productId":102}')
assert_eq "second order on 1-unit stock is rejected" "false" "$([ "$order3_status" = "201" ] && echo true || echo false)"

echo ""
echo "=== Test 4: concurrent orders never oversell (through the HTTP layer, not just direct DB access) ==="
curl -s -X PATCH "$STOCK_URL/product/103/stock" -H "Content-Type: application/json" \
  -d '{"product":"Concurrency Widget","qtd":5}' >/dev/null
succeeded=0
for i in $(seq 1 10); do
  (curl -s -o /tmp/concurrent_$i.json -w '%{http_code}' -X POST "$ORDER_URL/orders" \
    -H "Content-Type: application/json" -d '{"productId":103}' > /tmp/concurrent_status_$i.txt) &
done
wait
for i in $(seq 1 10); do
  [ "$(cat /tmp/concurrent_status_$i.txt)" = "201" ] && succeeded=$((succeeded + 1))
done
assert_eq "exactly 5 of 10 concurrent orders succeed" "5" "$succeeded"
stock_after4=$(curl -s "$STOCK_URL/product/103")
assert_eq "final stock never oversold" '{"ID":103,"IN_STOCK":0,"RESERVE":0,"SOLD":5}' "$stock_after4"
rm -f /tmp/concurrent_*.json /tmp/concurrent_status_*.txt

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
