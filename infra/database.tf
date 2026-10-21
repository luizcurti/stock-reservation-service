# MySQL 8.4, the version docker-compose uses. The master password is generated and stored by RDS
# in Secrets Manager; ECS injects it as DB_PASSWORD, so it never appears in Terraform state or
# the task definitions. The schema (services/stock-service/SQL/stock.sql, which docker-compose
# mounts into the MySQL init directory) is applied by the one-off `schema` task in app.tf.
#
# TLS: stock-service connects with DB_SSL=true (encrypted, without verifying the certificate:
# no CA bundle in the image). The instance is not publicly accessible and its security group
# only admits the service tasks.

resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.public[*].id
}

resource "aws_db_instance" "main" {
  identifier     = local.name
  engine         = "mysql"
  engine_version = "8.4"
  instance_class = var.db_instance_class

  allocated_storage = 20
  storage_type      = "gp3"
  storage_encrypted = true

  db_name                     = "stock"
  username                    = "app"
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false
  multi_az               = false

  # Demo stack, torn down by the Destroy workflow: no final snapshot, no deletion protection.
  backup_retention_period    = 1
  skip_final_snapshot        = true
  deletion_protection        = false
  apply_immediately          = true
  auto_minor_version_upgrade = true
}
