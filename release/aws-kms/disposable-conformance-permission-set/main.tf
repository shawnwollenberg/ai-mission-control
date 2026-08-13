terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0, < 7.0"
    }
  }
}

variable "identity_center_instance_arn" {
  type = string
}

variable "human_principal_id" {
  description = "Identity Store user ID for the explicitly authorized human."
  type        = string
}

variable "target_account_id" {
  type    = string
  default = "661452835066"

  validation {
    condition     = var.target_account_id == "661452835066"
    error_message = "The disposable conformance permission set is restricted to account 661452835066."
  }
}

locals {
  tagged_key_arn = "arn:aws:kms:us-east-1:${var.target_account_id}:key/*"
  tagged_key_conditions = {
    StringEquals = {
      "aws:RequestedRegion"            = "us-east-1"
      "aws:ResourceTag/purpose"        = "release-authority-conformance"
      "aws:ResourceTag/environment"    = "disposable"
      "aws:ResourceTag/owner"          = "Shawn"
      "aws:ResourceTag/cleanup-intent" = "schedule-deletion-7-days"
      "kms:KeySpec"                    = "ECC_NIST_EDWARDS25519"
      "kms:KeyUsage"                   = "SIGN_VERIFY"
      "kms:KeyOrigin"                  = "AWS_KMS"
    }
    Bool = {
      "kms:MultiRegion" = "false"
    }
  }
  permission_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "CreateOnlyTaggedDisposableEd25519SigningKeys"
        Effect   = "Allow"
        Action   = ["kms:CreateKey", "kms:TagResource"]
        Resource = "*"
        Condition = {
          StringEquals = {
            "aws:RequestedRegion"           = "us-east-1"
            "kms:KeySpec"                   = "ECC_NIST_EDWARDS25519"
            "kms:KeyUsage"                  = "SIGN_VERIFY"
            "kms:KeyOrigin"                 = "AWS_KMS"
            "aws:RequestTag/purpose"        = "release-authority-conformance"
            "aws:RequestTag/environment"    = "disposable"
            "aws:RequestTag/owner"          = "Shawn"
            "aws:RequestTag/cleanup-intent" = "schedule-deletion-7-days"
          }
          Bool = {
            "kms:MultiRegion" = "false"
          }
          "ForAllValues:StringEquals" = {
            "aws:TagKeys" = ["purpose", "environment", "owner", "cleanup-intent"]
          }
        }
      },
      {
        Sid       = "InspectOnlyTaggedDisposableConformanceKeys"
        Effect    = "Allow"
        Action    = ["kms:DescribeKey", "kms:GetKeyPolicy", "kms:GetPublicKey", "kms:ListGrants", "kms:ListResourceTags"]
        Resource  = local.tagged_key_arn
        Condition = local.tagged_key_conditions
      },
      {
        Sid      = "SignAndVerifyOnlyRawEd25519ConformanceMessages"
        Effect   = "Allow"
        Action   = ["kms:Sign", "kms:Verify"]
        Resource = local.tagged_key_arn
        Condition = {
          StringEquals = merge(local.tagged_key_conditions.StringEquals, {
            "kms:SigningAlgorithm" = "ED25519_SHA_512"
            "kms:MessageType"      = "RAW"
          })
          Bool = local.tagged_key_conditions.Bool
        }
      },
      {
        Sid       = "DisableOnlyTaggedDisposableConformanceKeys"
        Effect    = "Allow"
        Action    = "kms:DisableKey"
        Resource  = local.tagged_key_arn
        Condition = local.tagged_key_conditions
      },
      {
        Sid      = "ScheduleSevenDayDeletionOnlyForTaggedDisposableConformanceKeys"
        Effect   = "Allow"
        Action   = "kms:ScheduleKeyDeletion"
        Resource = local.tagged_key_arn
        Condition = merge(local.tagged_key_conditions, {
          NumericEquals = {
            "kms:ScheduleKeyDeletionPendingWindowInDays" = "7"
          }
        })
      },
      {
        Sid      = "InspectAliasesInApprovedAccountAndRegion"
        Effect   = "Allow"
        Action   = "kms:ListAliases"
        Resource = "*"
        Condition = {
          StringEquals = {
            "aws:RequestedRegion" = "us-east-1"
            "kms:CallerAccount"   = var.target_account_id
          }
        }
      },
      {
        Sid      = "InspectKmsCloudTrailEvidence"
        Effect   = "Allow"
        Action   = "cloudtrail:LookupEvents"
        Resource = "*"
        Condition = {
          StringEquals = {
            "aws:RequestedRegion" = "us-east-1"
          }
        }
      },
      {
        Sid    = "DenyEveryUnrelatedAwsAction"
        Effect = "Deny"
        NotAction = [
          "kms:CreateKey",
          "kms:TagResource",
          "kms:DescribeKey",
          "kms:GetKeyPolicy",
          "kms:GetPublicKey",
          "kms:ListAliases",
          "kms:ListGrants",
          "kms:ListResourceTags",
          "kms:Sign",
          "kms:Verify",
          "kms:DisableKey",
          "kms:ScheduleKeyDeletion",
          "cloudtrail:LookupEvents"
        ]
        Resource = "*"
      }
    ]
  }
}

resource "aws_ssoadmin_permission_set" "disposable_kms_conformance" {
  instance_arn     = var.identity_center_instance_arn
  name             = "ReleaseAuthorityDisposableKmsConformance"
  description      = "Temporary human-only permissions for the disposable Ed25519 KMS conformance test."
  session_duration = "PT1H"

  tags = {
    purpose     = "release-authority-conformance"
    environment = "disposable"
  }
}

resource "aws_ssoadmin_permission_set_inline_policy" "disposable_kms_conformance" {
  inline_policy      = jsonencode(local.permission_policy)
  instance_arn       = aws_ssoadmin_permission_set.disposable_kms_conformance.instance_arn
  permission_set_arn = aws_ssoadmin_permission_set.disposable_kms_conformance.arn
}

resource "aws_ssoadmin_account_assignment" "authorized_human" {
  instance_arn       = aws_ssoadmin_permission_set.disposable_kms_conformance.instance_arn
  permission_set_arn = aws_ssoadmin_permission_set.disposable_kms_conformance.arn
  principal_id       = var.human_principal_id
  principal_type     = "USER"
  target_id          = var.target_account_id
  target_type        = "AWS_ACCOUNT"

  depends_on = [aws_ssoadmin_permission_set_inline_policy.disposable_kms_conformance]
}

output "permission_set_arn" {
  value = aws_ssoadmin_permission_set.disposable_kms_conformance.arn
}
