# Kubernetes + Istio Service Mesh Demo

`stock-service` already solves the hard part of inventory management — reservation under concurrency, with `SELECT ... FOR UPDATE` transactions preventing overselling. This demo extends the system with two more services (`order-service`, `payment-service`) to create the thing a service mesh actually exists for: **synchronous, multi-hop HTTP traffic between independently deployed services**. mTLS, retries, timeouts, canary releases, and circuit breaking only mean something once there's more than one service in the conversation — this is that conversation.

Run entirely on a local [kind](https://kind.sigs.k8s.io/) cluster. Nothing here talks to a real payment processor or a real order system — `order-service` and `payment-service` are deliberately minimal in-memory stubs (see [Scope](#scope-and-honesty) below) that exist to be realistic HTTP hosts for the mesh to intercept.

## Call graph

```
                    ┌──────────────────┐
   client  ────────▶│   order-service   │
  (curl via         └─────────┬─────────┘
   ingress                    │
   gateway)          ┌────────┼────────┐
                      ▼                 ▼
             ┌─────────────────┐  ┌──────────────────┐
             │  stock-service   │  │  payment-service  │
             │   (v1 90% /      │  │                    │
             │    v2 10%)       │  └──────────────────┘
             └────────┬─────────┘
                      ▼
                  MySQL
```

`order-service` orchestrates a full order: reserve stock → charge payment → confirm the sale (or release the reservation if payment fails). Every arrow above is a real HTTP call, proxied transparently by each pod's injected Envoy sidecar.

## Quick start

```bash
scripts/mesh/kind-up.sh          # cluster + Istio (demo profile) + Kiali/Grafana/Prometheus/Jaeger
scripts/mesh/build-and-load.sh   # build the 3 service images, load them into kind
scripts/mesh/deploy.sh           # apply k8s manifests + baseline Istio config

# Place an order through the mesh:
curl -H "Host: order-service.stock-mesh.svc.cluster.local" \
  -X POST http://localhost:8080/orders \
  -H "Content-Type: application/json" -d '{"productId":1}'
```

Then walk through each capability below, in any order. `scripts/mesh/teardown.sh` deletes the kind cluster when you're done.

Note on Host headers: a VirtualService bound to the ingress gateway has its short `hosts` entry (e.g. `stock-service`) expanded by Istio to the service's full in-namespace FQDN for gateway route matching — so external `curl` calls need `-H "Host: <service>.stock-mesh.svc.cluster.local"`, not the short name. (Mesh-internal calls, like `order-service` calling `http://stock-service:3000`, use the short name as normal — that expansion only applies to gateway-bound routing.)

## mTLS

**Problem it solves:** by default, pod-to-pod traffic inside a Kubernetes cluster is plaintext. Anything that can see the network (a compromised pod, a misconfigured NetworkPolicy) can read or spoof it. Rolling out mutual TLS by hand — provisioning certs, rotating them, rejecting unauthenticated peers — is exactly the kind of undifferentiated work a mesh is built to absorb.

**Where:** [`deploy/istio/peer-authentication.yaml`](../deploy/istio/peer-authentication.yaml) — a namespace-wide `PeerAuthentication` with `mtls.mode: STRICT`. Every sidecar in `stock-mesh` now refuses plaintext connections, including from outside the mesh. No application code changed to get this.

**See it live:**
```bash
scripts/mesh/demo-mtls.sh
```
This does two things: `istioctl x describe pod` confirms `Workload mTLS mode: STRICT` is the effective policy, then it launches a curl pod **without** a sidecar (deliberately in the `default` namespace, since `stock-mesh` has automatic injection — a pod created there would get a sidecar too and wouldn't prove anything) and shows the plaintext call getting a `Connection reset by peer` from `stock-service`'s sidecar, not a normal HTTP response.

## Retries and timeouts

**Problem it solves:** downstream dependencies fail transiently — a pod restarting, a brief network blip, a GC pause. Without a retry policy, every one of those blips becomes a customer-visible order failure. Without a timeout, a slow dependency can hang a request indefinitely and exhaust the caller's thread/connection pool. Both are configured centrally, in infrastructure, not scattered through application `try/catch` blocks.

**Where:** every `VirtualService` in `deploy/istio/` carries a `retries` block (attempts + `perTryTimeout` + `retryOn`) and an overall `timeout`. The interesting one is [`deploy/istio/virtualservice-payment.yaml`](../deploy/istio/virtualservice-payment.yaml) — 2 retries, 1s per try, 3s overall, on the hop most likely to be flaky in a real system (an external payment processor).

**See it live:**
```bash
scripts/mesh/demo-resilience.sh
```
This has two phases, because "retries" and "timeout" are different tools for different failures:

- **Phase 1 — retries absorbing a real failure.** `payment-service` is switched to `CHAOS_MODE=flaky` (returns a genuine 503 on ~40% of requests). These are real upstream failures, so Envoy's retry policy actually retries them. Across 20 orders, ~19 typically still succeed — the failure rate visible to `order-service` is far lower than the ~40% actually happening at `payment-service`.
- **Phase 2 — timeout bounding a slow dependency.** [`deploy/istio/demo/fault-injection-payment.yaml`](../deploy/istio/demo/fault-injection-payment.yaml) injects a 5s delay on 60% of `payment-service` traffic via Istio's fault-injection filter. This is applied and removed only by this script — it's not part of the baseline deploy. Delayed requests hit the 3s overall timeout and fail fast and predictably instead of hanging.

Those two phases use different failure mechanisms on purpose: Envoy evaluates fault injection in a filter that runs **before** routing/retry logic, so an injected fault is never itself retried (that's documented Istio behavior — fault injection is for testing what a slow/dead dependency does to you, not for exercising retry logic). Genuine upstream failures (`CHAOS_MODE=flaky`) go through the real routing/retry path and do get retried. Getting this distinction wrong the first time (see [`services/payment-service/src/index.ts`](../services/payment-service/src/index.ts)'s `CHAOS_MODE` comment) is itself a useful thing to be able to explain in an interview.

## Canary release

**Problem it solves:** shipping a new version to 100% of traffic and finding out it's broken from your error dashboard is how outages happen. A canary lets you expose a new version to a small, controlled slice of real traffic, watch it, and only then ramp up — or roll back with a one-line config change, no redeploy.

**Where:** [`deploy/k8s/stock-service.yaml`](../deploy/k8s/stock-service.yaml) runs `stock-service-v1` and `stock-service-v2` as separate Deployments, distinguished only by the `version` pod label and a `SERVICE_VERSION` env var (echoed back as the `X-Version` response header — see `app.ts`). [`deploy/istio/destinationrule-stock.yaml`](../deploy/istio/destinationrule-stock.yaml) defines `v1`/`v2` subsets from that label; [`deploy/istio/virtualservice-stock.yaml`](../deploy/istio/virtualservice-stock.yaml) splits traffic 90/10 between them.

v1 and v2 intentionally run the *same image* here — the point being demonstrated is the mesh's traffic-shifting mechanism (label-based subsets + weighted routing), which is identical regardless of whether v2 is a real new release or, as here, a config-only variant. Promoting a canary to 100%, or rolling it back to 0%, is a one-line weight change in that same file — no new deployment, no rebuild.

**See it live:**
```bash
scripts/mesh/demo-canary.sh 50
```
Fires 50 requests at `stock-service` through the ingress gateway and tallies the `X-Version` header — expect roughly 45/5.

## Circuit breaking

**Problem it solves:** retries help with transient failures, but hammering a genuinely dead dependency with retried requests just makes the outage worse for everyone else — the classic cascading-failure pattern. A circuit breaker stops sending traffic to an endpoint that's failing consistently, giving it room to recover instead of piling on.

**Where:** [`deploy/istio/destinationrule-stock.yaml`](../deploy/istio/destinationrule-stock.yaml) and [`deploy/istio/destinationrule-payment.yaml`](../deploy/istio/destinationrule-payment.yaml) both set `outlierDetection`: after 5 (stock) / 3 (payment) consecutive 5xx responses, that endpoint is ejected from the load-balancing pool for 30s.

**See it live:** set `payment-service` to a hard, permanent outage (as opposed to the `flaky`/intermittent mode used in the retries demo above) and watch it get ejected rather than continuing to eat every request:
```bash
kubectl set env deployment/payment-service -n stock-mesh CHAOS_MODE=fail
# fire a few orders — they'll fail immediately once outlier detection ejects the pod,
# rather than each one waiting through the full retry budget first
kubectl set env deployment/payment-service -n stock-mesh CHAOS_MODE=off   # restore
```

## Observability

**Problem it solves:** in a single monolith, "what's slow" and "what's broken" are questions you answer by reading one log file. Across services, you need a map of who's calling whom, at what latency, with what error rate and what fraction over mTLS — without adding tracing code to every service by hand.

**Where:** `scripts/mesh/kind-up.sh` installs Istio's standard demo-profile addons (Prometheus, Grafana, Jaeger, Kiali). The mesh graph, per-hop mTLS status, and network-level latency/error rate in Kiali/Grafana come from the sidecars alone — no application code involved. Each service also exposes its own `GET /metrics` (Prometheus format, via `prom-client`): HTTP request duration by route, plus `stock-service`-specific business metrics (active reservations, rate-limit rejections, reservations auto-released by expiry). `deploy/k8s/*.yaml` annotates every pod (`prometheus.io/scrape: "true"`) so the same already-installed Prometheus instance also scrapes these.

**See it live:**
```bash
scripts/mesh/open-dashboards.sh
```
Opens Kiali (the mesh graph — generate some traffic first with `demo-canary.sh` or a few manual orders, then watch the graph draw itself, complete with the mTLS padlock icons on each edge and the 90/10 split rendered as two weighted edges into `stock-service`) and Grafana (the standard Istio service/workload dashboards — request rate, error rate, latency percentiles, all broken down per version). Query the application-level metrics directly at `http://localhost:9090` (Prometheus's own UI, port-forward with `kubectl port-forward -n istio-system svc/prometheus 9090:9090`) — e.g. `reservations_active` or `rate(http_request_duration_seconds_count[1m])`.

## Scope and honesty

This is a demo of mesh *mechanics*, not a production system, and it's worth being explicit about where the line is:

- `order-service` and `payment-service` are single-file, in-memory Express stubs — no persistence, no tests, no layered architecture. They exist to be realistic synchronous HTTP hosts, not to be correct order/payment systems.
- MySQL runs as a single replica with an `emptyDir` volume in `deploy/k8s/mysql.yaml` — data is lost on pod restart. Fine for a demo; not how you'd run a database in a real cluster.
- Credentials in `deploy/k8s/mysql.yaml` are plaintext in a `Secret` manifest committed to the repo. Also fine for a local throwaway demo; never do this against a real cluster (use a real secrets manager / sealed secrets / external-secrets).
- The Istio "demo" install profile is intentionally permissive (broader default access, verbose tracing) and is documented by Istio itself as unsuitable for production.
- `stock-service`'s v1/v2 canary shares one image differing only by an env var, as explained above — a real canary is normally a genuinely new build.

None of that undermines what's being demonstrated: the mesh features themselves (mTLS enforcement, retry/timeout policy, weighted traffic splitting, outlier detection, telemetry) work identically whether the workloads behind them are these stubs or real production services — that separation of concerns (mesh handles cross-cutting network behavior, application code handles business logic) is the entire point of the pattern.
