#!/usr/bin/env bash
# Opens Kiali (mesh graph, mTLS padlocks, traffic split visualization) and
# Grafana (Istio service/workload dashboards) via istioctl's built-in
# port-forwarding helper. Runs in the foreground — Ctrl+C stops both.
set -euo pipefail

echo "==> Opening Kiali and Grafana dashboards (Ctrl+C to stop port-forwarding)"
istioctl dashboard kiali &
KIALI_PID=$!
istioctl dashboard grafana &
GRAFANA_PID=$!

trap 'kill "$KIALI_PID" "$GRAFANA_PID" 2>/dev/null' EXIT
wait
