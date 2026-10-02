#!/usr/bin/env bash
# Integration test for the 3-service system running via docker-compose —
# exercises real HTTP calls across order-service -> stock-service ->
# payment-service, which no per-service test suite covers on its own, then
# runs the API collection (collections/) against the same live stack.
# Run locally (`scripts/integration-test.sh`) or via the "docker" CI job
# (.github/workflows/ci.yml).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

TMP_DIR="$(mktemp -d)"

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
  rm -rf "$TMP_DIR"
  exit "$exit_code"
}
trap cleanup EXIT

echo "==> Starting the full stack (docker compose)"
if ! docker compose up -d --build >"$TMP_DIR/compose.log" 2>&1; then
  echo "docker compose up failed:"
  cat "$TMP_DIR/compose.log"
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
order_status=$(curl -s -o "$TMP_DIR/order1.json" -w '%{http_code}' -X POST "$ORDER_URL/orders" \
  -H "Content-Type: application/json" -d '{"productId":100}')
assert_eq "order confirmed (201)" "201" "$order_status"
order_body=$(cat "$TMP_DIR/order1.json")
assert_eq "order status is confirmed" "confirmed" "$(echo "$order_body" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))' 2>/dev/null)"
stock_after=$(curl -s "$STOCK_URL/product/100")
assert_eq "stock decremented, sale recorded" '{"ID":100,"IN_STOCK":4,"RESERVE":0,"SOLD":1}' "$stock_after"

echo ""
echo "=== Test 2: payment-service failing (5xx) releases the reservation ==="
curl -s -X PATCH "$STOCK_URL/product/101/stock" -H "Content-Type: application/json" \
  -d '{"product":"Failing Payment Widget","qtd":5}' >/dev/null
CHAOS_MODE=fail docker compose up -d payment-service >"$TMP_DIR/compose.log" 2>&1
for i in $(seq 1 15); do
  s=$(curl -s -o /dev/null -w '%{http_code}' "$PAYMENT_URL/health")
  [ "$s" = "200" ] && break
  sleep 1
done
order2_status=$(curl -s -o "$TMP_DIR/order2.json" -w '%{http_code}' -X POST "$ORDER_URL/orders" \
  -H "Content-Type: application/json" -d '{"productId":101}')
assert_eq "order answers 502 (an outage, not a decline) when payment-service returns 503" "502" "$order2_status"
stock_after2=$(curl -s "$STOCK_URL/product/101")
assert_eq "reservation released back to stock" '{"ID":101,"IN_STOCK":5,"RESERVE":0,"SOLD":0}' "$stock_after2"

CHAOS_MODE=off docker compose up -d payment-service >"$TMP_DIR/compose.log" 2>&1
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
assert_eq "second order on 1-unit stock is rejected with 400" "400" "$order3_status"

echo ""
echo "=== Test 3b: payment-service unreachable releases the reservation ==="
curl -s -X PATCH "$STOCK_URL/product/104/stock" -H "Content-Type: application/json" \
  -d '{"product":"Outage Widget","qtd":2}' >/dev/null
docker compose stop payment-service >/dev/null 2>&1
order3b_status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$ORDER_URL/orders" \
  -H "Content-Type: application/json" -d '{"productId":104}')
assert_eq "order answers 502 when payment-service is down" "502" "$order3b_status"
assert_eq "reservation released back to stock" '{"ID":104,"IN_STOCK":2,"RESERVE":0,"SOLD":0}' "$(curl -s "$STOCK_URL/product/104")"
docker compose start payment-service >/dev/null 2>&1
for i in $(seq 1 30); do
  s=$(curl -s -o /dev/null -w '%{http_code}' "$PAYMENT_URL/health")
  [ "$s" = "200" ] && break
  sleep 1
done

echo ""
echo "=== Test 4: concurrent orders never oversell (through the HTTP layer, not just direct DB access) ==="
curl -s -X PATCH "$STOCK_URL/product/103/stock" -H "Content-Type: application/json" \
  -d '{"product":"Concurrency Widget","qtd":5}' >/dev/null
succeeded=0
for i in $(seq 1 10); do
  (curl -s -o "$TMP_DIR/concurrent_$i.json" -w '%{http_code}' -X POST "$ORDER_URL/orders" \
    -H "Content-Type: application/json" -d '{"productId":103}' > "$TMP_DIR/concurrent_status_$i.txt") &
done
wait
for i in $(seq 1 10); do
  [ "$(cat "$TMP_DIR/concurrent_status_$i.txt")" = "201" ] && succeeded=$((succeeded + 1))
done
assert_eq "exactly 5 of 10 concurrent orders succeed" "5" "$succeeded"
stock_after4=$(curl -s "$STOCK_URL/product/103")
assert_eq "final stock never oversold" '{"ID":103,"IN_STOCK":0,"RESERVE":0,"SOLD":5}' "$stock_after4"

echo ""
echo "=== Test 5: one view across cluster workers (WEB_CONCURRENCY > 1) ==="
# Each worker keeps its own in-memory state; without aggregation a scrape
# would only see the worker that answered it, and each worker would apply
# RATE_LIMIT_MAX on its own.
route_count() {
  curl -s "$STOCK_URL/metrics" | python3 -c '
import re, sys
total = 0
for line in sys.stdin:
    if line.startswith("http_request_duration_seconds_count") and "route=\"/product/:id\"" in line and "method=\"GET\"" in line:
        total += float(line.rsplit(" ", 1)[1])
print(int(total))'
}
before=$(route_count)
for i in $(seq 1 12); do curl -s -o /dev/null "$STOCK_URL/product/100"; done
after=$(route_count)
assert_eq "metrics count all 12 requests, whichever worker served them" "12" "$((after - before))"
remaining=$(for i in $(seq 1 6); do
  curl -s -o /dev/null -D - "$STOCK_URL/product/100" | tr -d '\r' | awk -F': ' 'tolower($1)=="ratelimit-remaining" {print $2}'
done | python3 -c '
import sys
vals = [int(v) for v in sys.stdin.read().split()]
print("decreasing" if len(vals) == 6 and all(b == a - 1 for a, b in zip(vals, vals[1:])) else "per-worker: %s" % vals)')
assert_eq "rate-limit budget is shared by all workers" "decreasing" "$remaining"

echo ""
echo "=== API collection (newman) ==="
if npx --yes newman@6 run collections/stock-reservation.postman_collection.json \
  --reporters cli --reporter-cli-no-assertions --reporter-cli-no-console; then
  assert_eq "API collection passes" "0" "0"
else
  assert_eq "API collection passes" "0" "1"
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
