# The three services on ECS Fargate behind one ALB, in place of the Istio ingress gateway of the
# mesh demo (deploy/): /orders -> order-service, /payments -> payment-service, everything else ->
# stock-service. order-service calls the other two over plain HTTP inside the VPC, at
# stock.<name>.internal and payment.<name>.internal (Cloud Map private DNS names), exactly as it
# calls app:3000 and payment-service:3002 in docker-compose.

locals {
  ns = aws_service_discovery_private_dns_namespace.main.name

  services = {
    stock-service = {
      port        = 3000
      dns_name    = "stock"
      path_prefix = null # default route
      secrets     = [{ name = "DB_PASSWORD", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:password::" }]
      environment = [
        { name = "DB_HOST", value = aws_db_instance.main.address },
        { name = "DB_PORT", value = tostring(aws_db_instance.main.port) },
        { name = "DB_NAME", value = aws_db_instance.main.db_name },
        { name = "DB_USER", value = aws_db_instance.main.username },
        { name = "DB_SSL", value = "true" },
        # CloudFront, then the ALB: the client IP is two X-Forwarded-For hops back.
        { name = "TRUST_PROXY", value = "2" },
      ]
    }
    order-service = {
      port        = 3001
      dns_name    = "order"
      path_prefix = "/orders"
      secrets     = []
      environment = [
        { name = "STOCK_SERVICE_URL", value = "http://stock.${local.ns}:3000" },
        { name = "PAYMENT_SERVICE_URL", value = "http://payment.${local.ns}:3002" },
      ]
    }
    payment-service = {
      port        = 3002
      dns_name    = "payment"
      path_prefix = "/payments"
      secrets     = []
      environment = [{ name = "CHAOS_MODE", value = "off" }]
    }
  }

  min_port = min([for service in local.services : service.port]...)
  max_port = max([for service in local.services : service.port]...)
}

resource "aws_ecr_repository" "service" {
  for_each = local.services

  name                 = "${local.name}-${each.key}"
  image_tag_mutability = "MUTABLE"
  force_delete         = true # Destroy also removes the pushed images

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "service" {
  for_each = aws_ecr_repository.service

  repository = each.value.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 5 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 5
      }
      action = { type = "expire" }
    }]
  })
}

# One group for every container; each writes under its own stream prefix.
resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${local.name}-app"
  retention_in_days = var.log_retention_days
}

# --- IAM -------------------------------------------------------------------------------------

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Used by ECS to pull the images, write logs and inject the database password. None of the
# containers calls an AWS API, so there is no task role.
resource "aws_iam_role" "execution" {
  name               = "${local.name}-app-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  statement {
    sid       = "DatabasePassword"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_db_instance.main.master_user_secret[0].secret_arn]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

# --- ECS cluster and service discovery -------------------------------------------------------

resource "aws_ecs_cluster" "main" {
  name = local.name
}

resource "aws_service_discovery_private_dns_namespace" "main" {
  name        = "${local.name}.internal"
  description = "Private DNS names of ${local.name} services"
  vpc         = aws_vpc.main.id
}

resource "aws_service_discovery_service" "service" {
  for_each = local.services

  name = each.value.dns_name

  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.main.id
    routing_policy = "MULTIVALUE"

    dns_records {
      type = "A"
      ttl  = 10
    }
  }
}

# --- Schema (one-off task) -------------------------------------------------------------------
# docker-compose and the mesh demo load services/stock-service/SQL/stock.sql through MySQL's
# init directory, which RDS doesn't have. The deploy job runs this task after every apply; it
# only applies the file when the IN_STOCK table is missing, since the file starts with DROP TABLE
# statements (a fresh database each time it runs).

locals {
  schema_script = <<-EOT
    set -eu
    printf '[client]\nhost=%s\nuser=%s\npassword=%s\nssl-mode=REQUIRED\n' "$DB_HOST" "$DB_USER" "$DB_PASSWORD" > /tmp/my.cnf
    present=$(mysql --defaults-extra-file=/tmp/my.cnf -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$DB_NAME' AND table_name = 'IN_STOCK'")
    if [ "$present" = "1" ]; then
      echo "Schema already present, nothing to do."
    else
      echo "$SCHEMA_SQL_B64" | base64 -d | mysql --defaults-extra-file=/tmp/my.cnf
      echo "Schema applied."
    fi
  EOT
}

resource "aws_ecs_task_definition" "schema" {
  family                   = "${local.name}-schema"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name      = "schema"
    image     = var.mysql_client_image
    essential = true
    command   = ["sh", "-c", local.schema_script]

    environment = [
      { name = "DB_HOST", value = aws_db_instance.main.address },
      { name = "DB_NAME", value = aws_db_instance.main.db_name },
      { name = "DB_USER", value = aws_db_instance.main.username },
      { name = "SCHEMA_SQL_B64", value = filebase64("${path.module}/../services/stock-service/SQL/stock.sql") },
    ]
    secrets = local.services["stock-service"].secrets

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.app.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "schema"
      }
    }
  }])
}

# --- Services ----------------------------------------------------------------------------------

resource "aws_ecs_task_definition" "service" {
  for_each = local.services

  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name      = each.key
    image     = "${aws_ecr_repository.service[each.key].repository_url}:${var.app_image_tag}"
    essential = true

    # tini as PID 1 (zombie reaping, signal forwarding).
    linuxParameters = { initProcessEnabled = true }

    portMappings = [{ containerPort = each.value.port, protocol = "tcp" }]

    environment = concat([
      { name = "NODE_ENV", value = "production" },
      { name = "PORT", value = tostring(each.value.port) },
      # One process per 0.25-vCPU task: ECS scales by adding tasks, not cluster workers.
      { name = "WEB_CONCURRENCY", value = "1" },
    ], each.value.environment)
    secrets = each.value.secrets

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.app.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = each.key
      }
    }
  }])
}

resource "aws_lb" "app" {
  name               = "${local.name}-alb"
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id

  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "service" {
  for_each = local.services

  name        = "${local.name}-${each.value.dns_name}"
  port        = each.value.port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id

  deregistration_delay = 10

  health_check {
    path                = "/health"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service["stock-service"].arn
  }
}

resource "aws_lb_listener_rule" "service" {
  for_each = { for key, service in local.services : key => service if service.path_prefix != null }

  listener_arn = aws_lb_listener.http.arn
  priority     = each.value.port # unique per service

  condition {
    path_pattern {
      values = [each.value.path_prefix, "${each.value.path_prefix}/*"]
    }
  }

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service[each.key].arn
  }
}

resource "aws_ecs_service" "service" {
  for_each = local.services

  name            = "${local.name}-${each.key}"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.service[each.key].arn
  desired_count   = 1
  launch_type     = "FARGATE"

  health_check_grace_period_seconds = 30

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = true # reaches ECR and Secrets Manager without a NAT gateway
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.service[each.key].arn
    container_name   = each.key
    container_port   = each.value.port
  }

  service_registries {
    registry_arn = aws_service_discovery_service.service[each.key].arn
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener.http, aws_iam_role_policy.execution_secrets]
}
