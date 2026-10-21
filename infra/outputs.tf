output "api_url" {
  description = "Base URL over HTTPS: /product/... (stock-service), /orders (order-service), /payments (payment-service)."
  value       = "https://${aws_cloudfront_distribution.main.domain_name}"
}

output "ecr_repository_urls" {
  description = "ECR repository per service directory under services/."
  value       = { for key, repo in aws_ecr_repository.service : key => repo.repository_url }
}

output "ecs_cluster" {
  value = aws_ecs_cluster.main.name
}

output "ecs_services" {
  value = [for service in aws_ecs_service.service : service.name]
}

# Everything the deploy job needs to run the one-off schema task.
output "schema_task" {
  value = {
    task_definition = aws_ecs_task_definition.schema.arn
    subnets         = aws_subnet.public[*].id
    security_group  = aws_security_group.app.id
    log_group       = aws_cloudwatch_log_group.app.name
  }
}
