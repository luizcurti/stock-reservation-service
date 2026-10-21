# Deployment (AWS)

Every push to `main` deploys the three services to AWS with GitHub Actions,
once the CI checks pass. Where the mesh demo has an Istio ingress gateway and
Envoy sidecars, this deployment has one ALB and plain HTTP inside the VPC:

```
           HTTPS                 HTTP (CloudFront ranges only)
client ──► CloudFront ─────────► ALB ─┬─ /orders*   ──► order-service   (ECS Fargate)
                                      ├─ /payments* ──► payment-service (ECS Fargate)
                                      └─ everything else ► stock-service (ECS Fargate) ──► RDS MySQL 8.4

order-service ──► stock.stock-res.internal:3000, payment.stock-res.internal:3002 (Cloud Map)
```

| docker-compose service | AWS                                                                           |
| ---------------------- | ----------------------------------------------------------------------------- |
| `app` (stock-service)  | ECS Fargate service, default route of the ALB, Cloud Map name `stock`         |
| `order-service`        | ECS Fargate service, ALB route `/orders`                                      |
| `payment-service`      | ECS Fargate service, ALB route `/payments`, Cloud Map name `payment`          |
| `mysql_database`       | RDS MySQL 8.4 (`db.t4g.micro`), `DB_SSL=true`, schema from a one-off ECS task |

Notes:

- **Schema**: docker-compose and the mesh demo load
  `services/stock-service/SQL/stock.sql` through MySQL's init directory, which
  RDS doesn't have. The deploy job runs a one-off ECS task (the `mysql:8.4`
  image's client) after every apply; it loads the file only when the `IN_STOCK`
  table is missing, because the file starts with `DROP TABLE`.
- **Secrets**: the MySQL password is managed by RDS in Secrets Manager and
  injected by ECS as `DB_PASSWORD`.
- **One process per task** (`WEB_CONCURRENCY=1`): each task has 0.25 vCPU, and
  ECS scales by adding tasks rather than cluster workers.
- **`TRUST_PROXY=2`** (CloudFront, then the ALB) keeps stock-service's per-IP
  rate limiter keyed on the client.
- **No authentication**, as locally: anyone with the URL can change stock
  levels. Destroy the stack when you are done testing. `/metrics` of
  stock-service is public too (the API collection asserts on it).
- **Network**: public subnets and no NAT gateway (tasks get a public IP to
  reach ECR and Secrets Manager). Only the ALB accepts traffic from outside the
  VPC, and only from CloudFront; MySQL only accepts the service tasks.

## One-time setup

Requirements: Terraform >= 1.10, AWS CLI credentials (admin) of the target
account, and the GitHub CLI logged in with admin access to the repository.

```bash
scripts/bootstrap.sh
```

It applies [`bootstrap/`](../bootstrap) (an S3 bucket for the Terraform state
and an IAM role GitHub Actions assumes through OIDC, scoped to the
`stock-res-*` resources and the `production` environment), then creates the
`production` GitHub environment with the `AWS_DEPLOY_ROLE_ARN`,
`TF_STATE_BUCKET` and `AWS_REGION` variables. On an account where no other
project created the GitHub OIDC provider yet, run
`scripts/bootstrap.sh -var="create_oidc_provider=true"`.

## Deploy

Every push to `main` deploys; to deploy without a push:

```bash
gh workflow run ci.yml --repo luizcurti/stock-reservation-service --ref main
```

The **Deploy to AWS** job creates the three ECR repositories, builds and pushes
the images, applies [`infra/`](../infra) (the first run takes ~15 minutes,
mostly RDS), loads the schema, waits for the ECS services and runs
[`scripts/smoke-test.sh`](../scripts/smoke-test.sh) against the live stack: the
API collection's stock-service and order-service folders, then 8 concurrent
orders against a product with 3 units, which must confirm exactly 3 and leave
`IN_STOCK 0, RESERVE 0, SOLD 3` — no overselling across order-service,
stock-service's row locks in MySQL and payment-service.

## Try it

```bash
API=https://xxxx.cloudfront.net   # from the run summary
curl -s $API/product/1
curl -s -X POST $API/orders -H 'Content-Type: application/json' -d '{"productId":1}'
curl -s $API/product/1
```

## Destroy

RDS, the ALB and the Fargate tasks are billed by the hour. Tear the stack down
when you are done (the bootstrap resources are kept):

```bash
gh workflow run destroy.yml --repo luizcurti/stock-reservation-service --ref main -f confirm=destroy
```

Recreate it with the deploy command above.
