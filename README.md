# stock-reservation-service

![stock-service coverage](https://img.shields.io/badge/stock--service_coverage-100%25-brightgreen)

A stock reservation system built as three services, to demonstrate the two things that matter once you cross from "one API" to "microservices": correct concurrency handling inside a service, and correct traffic behavior *between* services.

- **[stock-service](services/stock-service/)** — the core: reserve/sell/return inventory with `SELECT ... FOR UPDATE` transactions, so concurrent requests on the same product can't oversell it. TypeScript, Express, MySQL. See its own [README](services/stock-service/README.md) for the full API reference.
- **order-service** — orchestrates an order: reserve stock → charge payment → confirm the sale (or release the reservation if payment fails). A minimal in-memory stub — it exists to be a realistic synchronous caller, not a production order system.
- **payment-service** — a fake payment authorizer with a `CHAOS_MODE` toggle (`off` / `flaky` / `fail` / `slow`, with `CHAOS_SLOW_MS` setting the `slow` delay) for exercising failure handling on demand. Also a minimal in-memory stub.

order-service answers `201` for a confirmed order, passes stock-service's status through when the reservation fails (`400` insufficient stock, `404` unknown product), `402` when payment-service refuses the payment (a 4xx), and `502` when a downstream service is unreachable or failing (a 5xx) — an outage is never reported as a declined payment. Whenever the order can't complete after stock was reserved, the reservation is released.

The three talk to each other over real HTTP, which is what makes the [Kubernetes + Istio service mesh demo](docs/mesh.md) meaningful: mTLS, retries/timeouts, canary releases, and circuit breaking only do something once there's inter-service traffic for them to act on.

## Architecture

![System architecture](docs/img/system-architecture.png)

The big pieces and how a request flows through them — not a literal deployment diagram (see [docs/mmd](docs/mmd) for that, and [docs/mesh.md](docs/mesh.md) for the Kubernetes + Istio topology in full).

## Running it

**Just the API, for local development** (no mesh, no Kubernetes):
```bash
docker compose up -d --build
curl http://localhost:3000/health   # stock-service
curl http://localhost:3001/health   # order-service
curl http://localhost:3002/health   # payment-service

curl -X POST http://localhost:3001/orders \
  -H "Content-Type: application/json" -d '{"productId":1}'
```
See [services/stock-service/README.md](services/stock-service/README.md) for the full stock-service API, environment variables, and test suite.

To verify the whole stack end to end (not just stock-service in isolation) — happy path, payment-service failing or down releasing the reservation, insufficient stock, concurrent orders never overselling, metrics and rate limiting staying consistent across stock-service's cluster workers, and the API collection in [collections/](collections/) — all over real HTTP:
```bash
scripts/integration-test.sh
```

**The full Kubernetes + Istio mesh demo** — mTLS, retry/timeout policies, a 90/10 canary release, circuit breaking, and Kiali/Grafana observability, all running on a local [kind](https://kind.sigs.k8s.io/) cluster:
```bash
scripts/mesh/kind-up.sh
scripts/mesh/build-and-load.sh
scripts/mesh/deploy.sh
scripts/mesh/demo-canary.sh
```
Full walkthrough, one section per capability with the exact YAML responsible and the command to see it live: **[docs/mesh.md](docs/mesh.md)**.

**Deployed on AWS** — the three services on ECS Fargate behind CloudFront and one ALB, with RDS MySQL, deployed by GitHub Actions on every push to `main` ([docs/deployment.md](docs/deployment.md)):
```bash
scripts/bootstrap.sh                                                                                 # once: state bucket, deploy role, GitHub environment
gh workflow run ci.yml --repo luizcurti/stock-reservation-service --ref main                         # deploy
gh workflow run destroy.yml --repo luizcurti/stock-reservation-service --ref main -f confirm=destroy # tear down
```

## Repository structure

```
stock-reservation-service/
├── services/
│   ├── stock-service/     # the core inventory API (see its own README)
│   ├── order-service/     # order orchestration stub
│   └── payment-service/   # fake payment authorizer stub
├── deploy/
│   ├── k8s/                # namespace, MySQL, and Deployments/Services for all three
│   └── istio/               # PeerAuthentication, DestinationRules, VirtualServices, Gateway
├── scripts/
│   ├── mesh/                 # kind/Istio automation — cluster up, build, deploy, and demo scripts
│   ├── integration-test.sh   # whole-stack HTTP integration test (docker compose)
│   ├── bootstrap.sh          # one-time AWS + GitHub setup for the deploy job
│   └── smoke-test.sh         # end-to-end checks against the AWS deployment
├── infra/                   # Terraform for the AWS deployment (ECS Fargate, ALB, CloudFront, RDS MySQL)
├── bootstrap/               # Terraform for the state bucket and the GitHub OIDC deploy role
├── collections/             # Postman collection for all three APIs (run by integration-test.sh via newman)
├── docs/                    # architecture diagrams + the mesh demo walkthrough
├── .github/workflows/       # CI (see below)
└── docker-compose.yml       # all three services + MySQL, for local dev without Kubernetes
```

## CI

GitHub Actions ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs on every push/PR to `main`, in five jobs:

1. **test** — audits, format-checks, lints, typechecks, and unit-tests `stock-service` (100% coverage), then runs its e2e suite against real MySQL.
2. **test-stubs** — the same audit, format check, lint, typecheck and unit tests (with coverage thresholds) for `order-service` and `payment-service`.
3. **docker** — once both pass, builds and starts all three services + MySQL via `docker compose`, then runs [`scripts/integration-test.sh`](scripts/integration-test.sh) against the live stack (see [Running it](#running-it)).
4. **infra** — `terraform fmt` + `validate` of `infra/` and `bootstrap/`.
5. **deploy** (on `main` only) — pushes the three images, applies `infra/` through GitHub OIDC, loads the MySQL schema with a one-off ECS task, and runs [`scripts/smoke-test.sh`](scripts/smoke-test.sh) against the live AWS stack, including concurrent orders that must never oversell. A manual **Destroy** workflow tears it down ([docs/deployment.md](docs/deployment.md)).

The Kubernetes/Istio mesh demo is intentionally not part of CI — it's a local demo environment (see [docs/mesh.md](docs/mesh.md)'s [Scope and honesty](docs/mesh.md#scope-and-honesty) section), not a deployed system.
