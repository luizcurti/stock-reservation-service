# Permissions for the deploy role: everything the stack in ../infra needs to create, update and
# destroy, plus what the deploy job does around it (push the images, run the one-off schema
# task, wait for ECS). Scoped by the `${var.project_name}`
# name prefix wherever the service supports resource-level permissions.
#
# Unavoidably broader (all limited to this region where the service is regional):
#   - EC2 networking (VPC, subnets, gateways, route tables, security groups) uses generated
#     IDs and has patchy resource-level support: ec2:* in the region.
#   - Load balancers and target groups are matched by name prefix; their listeners and rules
#     by generated ARNs under them.
#   - ECS clusters/services/task definitions are matched by name prefix; RegisterTaskDefinition
#     and the Describe/List calls only accept "*".
#   - CloudFront is a global service with generated IDs and AWS-managed policies.
#   - RDS: instances, subnet groups and the master-password secret RDS manages are matched by
#     name; a few Describe calls only accept "*".
#   - Cloud Map (the private DNS names order-service calls stock and payment by) creates a Route 53 private hosted
#     zone with a generated ID: servicediscovery:* in the region, the Route 53 hosted-zone calls
#     on "*".
#   - Service-linked roles are created on first use in a fresh account (ECS, ELB, RDS).

locals {
  p      = var.project_name
  region = var.aws_region
  acct   = local.account_id

  in_region = {
    test     = "StringEquals"
    variable = "aws:RequestedRegion"
    values   = [var.aws_region]
  }
}

data "aws_iam_policy_document" "deploy_permissions" {
  statement {
    sid       = "StateBucketList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.tfstate.arn]
  }

  statement {
    sid       = "StateObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.tfstate.arn}/*"]
  }

  statement {
    sid       = "Rds"
    actions   = ["rds:*"]
    resources = ["*"]

    condition {
      test     = local.in_region.test
      variable = local.in_region.variable
      values   = local.in_region.values
    }
  }

  # manage_master_user_password: RDS creates, rotates and deletes the secret on the caller's
  # behalf, under the reserved rds! prefix.
  statement {
    sid       = "RdsManagedSecret"
    actions   = ["secretsmanager:*"]
    resources = ["arn:aws:secretsmanager:${local.region}:${local.acct}:secret:rds!*"]
  }

  statement {
    sid       = "CloudMap"
    actions   = ["servicediscovery:*"]
    resources = ["*"]

    condition {
      test     = local.in_region.test
      variable = local.in_region.variable
      values   = local.in_region.values
    }
  }

  statement {
    sid = "CloudMapPrivateHostedZone"
    actions = [
      "route53:CreateHostedZone",
      "route53:DeleteHostedZone",
      "route53:GetHostedZone",
      "route53:ListHostedZonesByName",
      "route53:ChangeResourceRecordSets",
      "route53:ListResourceRecordSets",
      "route53:GetChange",
      "route53:ChangeTagsForResource",
      "route53:ListTagsForResource",
      "route53:AssociateVPCWithHostedZone",
    ]
    resources = ["*"]
  }

  # SSM parameters under the project prefix.
  statement {
    sid       = "SsmParameters"
    actions   = ["ssm:*"]
    resources = ["arn:aws:ssm:${local.region}:${local.acct}:parameter/${local.p}/*"]
  }

  statement {
    sid       = "KmsViaSsmAndSecretsManager"
    actions   = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey", "kms:CreateGrant"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${local.region}.amazonaws.com", "secretsmanager.${local.region}.amazonaws.com", "rds.${local.region}.amazonaws.com"]
    }
  }

  statement {
    sid       = "Ec2Networking"
    actions   = ["ec2:*"]
    resources = ["*"]

    condition {
      test     = local.in_region.test
      variable = local.in_region.variable
      values   = local.in_region.values
    }
  }

  statement {
    sid       = "LoadBalancing"
    actions   = ["elasticloadbalancing:*"]
    resources = ["*"]

    condition {
      test     = local.in_region.test
      variable = local.in_region.variable
      values   = local.in_region.values
    }
  }

  statement {
    sid       = "Ecs"
    actions   = ["ecs:*"]
    resources = ["*"]

    condition {
      test     = local.in_region.test
      variable = local.in_region.variable
      values   = local.in_region.values
    }
  }

  statement {
    sid       = "EcrRepository"
    actions   = ["ecr:*"]
    resources = ["arn:aws:ecr:${local.region}:${local.acct}:repository/${local.p}-*"]
  }

  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid       = "CloudFront"
    actions   = ["cloudfront:*"]
    resources = ["*"]
  }

  statement {
    sid = "IamProjectRoles"
    actions = [
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:GetRole",
      "iam:UpdateRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:ListRoleTags",
      "iam:PutRolePolicy",
      "iam:GetRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:ListRolePolicies",
      "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole",
    ]
    resources = ["arn:aws:iam::${local.acct}:role/${local.p}-*"]
  }

  # The only managed policy the stack attaches. Restricting attachments to it stops the deploy
  # role from attaching e.g. AdministratorAccess to a role it creates.
  statement {
    sid       = "IamAttachEcsExecutionPolicyOnly"
    actions   = ["iam:AttachRolePolicy", "iam:DetachRolePolicy"]
    resources = ["arn:aws:iam::${local.acct}:role/${local.p}-*"]

    condition {
      test     = "ArnEquals"
      variable = "iam:PolicyARN"
      values   = ["arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"]
    }
  }

  statement {
    sid       = "IamPassProjectRolesToEcsTasks"
    actions   = ["iam:PassRole"]
    resources = ["arn:aws:iam::${local.acct}:role/${local.p}-*"]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }

  statement {
    sid     = "ServiceLinkedRoles"
    actions = ["iam:CreateServiceLinkedRole"]
    resources = [
      "arn:aws:iam::${local.acct}:role/aws-service-role/ecs.amazonaws.com/*",
      "arn:aws:iam::${local.acct}:role/aws-service-role/elasticloadbalancing.amazonaws.com/*",
      "arn:aws:iam::${local.acct}:role/aws-service-role/rds.amazonaws.com/*",
    ]

    condition {
      test     = "StringEquals"
      variable = "iam:AWSServiceName"
      values   = ["ecs.amazonaws.com", "elasticloadbalancing.amazonaws.com", "rds.amazonaws.com"]
    }
  }

  statement {
    sid       = "LogGroups"
    actions   = ["logs:*"]
    resources = ["arn:aws:logs:${local.region}:${local.acct}:log-group:/ecs/${local.p}-*"]
  }

  statement {
    sid = "AccountWideReads"
    actions = [
      "sts:GetCallerIdentity",
      "logs:DescribeLogGroups",
      "ssm:DescribeParameters",
      "secretsmanager:ListSecrets",
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
    ]
    resources = ["*"]
  }

  # The deploy role matches the `${var.project_name}-*` prefix itself; never let it rewrite its
  # own trust or permissions.
  statement {
    sid    = "DenySelfModification"
    effect = "Deny"
    actions = [
      "iam:UpdateRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
      "iam:DeleteRole",
      "iam:TagRole",
      "iam:UntagRole",
    ]
    resources = [aws_iam_role.github_deploy.arn]
  }
}
