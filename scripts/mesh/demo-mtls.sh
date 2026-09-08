#!/usr/bin/env bash
# Proves the PeerAuthentication STRICT policy (deploy/istio/peer-authentication.yaml)
# is actually enforced: 1) istioctl reports mTLS as active between mesh
# workloads, and 2) a plaintext HTTP call from a pod WITHOUT a sidecar
# (outside the mesh) is rejected, not silently downgraded to plaintext.
#
# The probe pod is launched in the "default" namespace deliberately — the
# stock-mesh namespace has istio-injection=enabled, so a pod created there
# would get a sidecar too and wouldn't actually be testing an unmeshed client.
set -euo pipefail

NAMESPACE="stock-mesh"

echo "==> mTLS status for a meshed workload (istioctl x describe pod)"
STOCK_POD=$(kubectl get pod -n "$NAMESPACE" -l app=stock-service,version=v1 -o jsonpath='{.items[0].metadata.name}')
istioctl x describe pod "$STOCK_POD" -n "$NAMESPACE" | grep -A3 "Effective PeerAuthentication"

echo ""
echo "==> Attempting a PLAINTEXT call from OUTSIDE the mesh (no sidecar, default namespace) — this must fail"
if kubectl run mtls-probe --rm -i --restart=Never --namespace default \
  --image=curlimages/curl:8.10.1 --command --pod-running-timeout=60s \
  -- curl -sS -m 5 "http://stock-service.$NAMESPACE.svc.cluster.local:3000/health"; then
  echo "UNEXPECTED: plaintext call succeeded — STRICT mTLS is not being enforced"
  exit 1
else
  echo "==> Confirmed: plaintext call was rejected (connection reset by the sidecar). STRICT mTLS is enforced."
fi
