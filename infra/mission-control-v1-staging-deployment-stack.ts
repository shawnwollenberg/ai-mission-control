import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export type MissionControlV1StagingDeploymentStackProps = cdk.StackProps & {
  runId: string;
  operatorRoleArn: string;
  signerFunctionArn: string;
  signerRoleArn: string;
  attestationKeyArn: string;
};

const tags = (runId: string) => ({
  Environment: "staging",
  Project: "mission-control",
  Purpose: "v1-external-acceptance",
  Disposable: "true",
  ProductionAccess: "false",
  StagingRunId: runId,
});

export class MissionControlV1StagingDeploymentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MissionControlV1StagingDeploymentStackProps) {
    super(scope, id, props);
    const prefix = `mission-control-v1-staging-${props.runId}`;
    if (
      !/^[a-z0-9][a-z0-9-]{7,15}$/.test(props.runId) ||
      props.signerFunctionArn !== `arn:aws:lambda:${this.region}:${this.account}:function:mcv1-${props.runId}-signer` ||
      props.signerRoleArn !== `arn:aws:iam::${this.account}:role/${prefix}-authority-signer` ||
      !new RegExp(`^arn:aws:kms:${this.region}:${this.account}:key/[a-f0-9-]+$`).test(props.attestationKeyArn) ||
      !/^arn:aws:iam::\d{12}:role\/aws-reserved\/sso\.amazonaws\.com\/(?:us-east-1\/)?AWSReservedSSO_[A-Za-z0-9+=,.@_-]+_[a-f0-9]+$/.test(
        props.operatorRoleArn,
      )
    )
      throw new Error("Staging authority requires an exact run and Identity Center operator.");
    const exactTags = tags(props.runId);
    const tagConditions = { StringEquals: { "aws:RequestTag/StagingRunId": props.runId } };
    const resourceTagConditions = { StringEquals: { "aws:ResourceTag/StagingRunId": props.runId } };
    const templateBucket = new s3.Bucket(this, "TemplateBucket", {
      bucketName: `mc-v1-cfn-${props.runId}-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const permissionsBoundary = new iam.ManagedPolicy(this, "WorkloadPermissionsBoundary", {
      managedPolicyName: `${prefix}-workload-boundary`,
      statements: [
        new iam.PolicyStatement({
          actions: ["s3:GetObject", "s3:PutObject", "s3:ListBucket"],
          resources: [
            `arn:aws:s3:::mc-v1-stage-${props.runId}-${this.account}`,
            `arn:aws:s3:::mc-v1-stage-${props.runId}-${this.account}/*`,
          ],
        }),
        new iam.PolicyStatement({
          actions: [
            "logs:CreateLogStream",
            "logs:PutLogEvents",
            "logs:GetLogEvents",
            "logs:FilterLogEvents",
            "logs:DescribeLogStreams",
          ],
          resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/wallyweb/${prefix}:*`],
        }),
        new iam.PolicyStatement({
          actions: [
            "ecr:BatchCheckLayerAvailability",
            "ecr:GetDownloadUrlForLayer",
            "ecr:BatchGetImage",
            "ecr:DescribeImages",
          ],
          resources: [`arn:aws:ecr:${this.region}:${this.account}:repository/${prefix}`],
        }),
        new iam.PolicyStatement({ actions: ["ecr:GetAuthorizationToken", "sts:GetCallerIdentity"], resources: ["*"] }),
        new iam.PolicyStatement({
          actions: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret", "secretsmanager:PutSecretValue"],
          resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:${prefix}-*`],
        }),
        new iam.PolicyStatement({
          actions: ["rds:DescribeDBInstances"],
          resources: [`arn:aws:rds:${this.region}:${this.account}:db:${prefix}-postgres`],
        }),
        new iam.PolicyStatement({
          actions: ["kms:DescribeKey", "kms:GetPublicKey", "kms:Verify"],
          resources: [props.attestationKeyArn],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.DENY,
          actions: ["kms:Sign"],
          resources: ["*"],
        }),
        new iam.PolicyStatement({
          actions: ["lambda:InvokeFunction"],
          resources: [props.signerFunctionArn],
        }),
        new iam.PolicyStatement({
          actions: ["ecs:DescribeServices", "ecs:DescribeTasks", "ecs:RunTask", "ecs:StopTask"],
          resources: [
            `arn:aws:ecs:${this.region}:${this.account}:service/${prefix}-cluster/${prefix}-service`,
            `arn:aws:ecs:${this.region}:${this.account}:task/${prefix}-cluster/*`,
            `arn:aws:ecs:${this.region}:${this.account}:task-definition/${prefix}-*:*`,
          ],
        }),
        new iam.PolicyStatement({
          actions: ["ecs:ListTasks"],
          resources: ["*"],
          conditions: {
            ArnEquals: { "ecs:cluster": `arn:aws:ecs:${this.region}:${this.account}:cluster/${prefix}-cluster` },
          },
        }),
        new iam.PolicyStatement({
          actions: ["ecs:DescribeTaskDefinition", "elasticloadbalancing:DescribeTargetHealth"],
          resources: ["*"],
        }),
        new iam.PolicyStatement({
          actions: ["iam:PassRole"],
          resources: ["probe", "execution"].map((suffix) => `arn:aws:iam::${this.account}:role/${prefix}-${suffix}`),
          conditions: { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } },
        }),
      ],
    });
    const cloudFormationRole = new iam.Role(this, "CloudFormationRole", {
      roleName: `${prefix}-cloudformation`,
      assumedBy: new iam.ServicePrincipal("cloudformation.amazonaws.com"),
      maxSessionDuration: cdk.Duration.hours(2),
    });
    const deployerRole = new iam.Role(this, "DeployerRole", {
      roleName: `${prefix}-deployer`,
      assumedBy: new iam.ArnPrincipal(props.operatorRoleArn),
      maxSessionDuration: cdk.Duration.hours(2),
    });

    const mutateWithRequestTags = [
      "ec2:CreateVpc",
      "ec2:CreateSubnet",
      "ec2:CreateRouteTable",
      "ec2:CreateSecurityGroup",
      "ec2:CreateInternetGateway",
      "ec2:CreateNetworkAcl",
      "ecs:CreateCluster",
      "ecs:CreateService",
      "ecs:RegisterTaskDefinition",
      "ecr:CreateRepository",
      "rds:CreateDBInstance",
      "rds:CreateDBSubnetGroup",
      "secretsmanager:CreateSecret",
      "elasticloadbalancing:CreateLoadBalancer",
      "elasticloadbalancing:CreateTargetGroup",
      "logs:CreateLogGroup",
    ];
    cloudFormationRole.addToPolicy(
      new iam.PolicyStatement({ actions: mutateWithRequestTags, resources: ["*"], conditions: tagConditions }),
    );
    cloudFormationRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ec2:CreateTags"],
        resources: ["vpc", "internet-gateway", "subnet", "route-table", "security-group", "network-acl"].map(
          (kind) => `arn:aws:ec2:${this.region}:${this.account}:${kind}/*`,
        ),
        conditions: {
          StringEquals: {
            "ec2:CreateAction": [
              "CreateVpc",
              "CreateInternetGateway",
              "CreateSubnet",
              "CreateRouteTable",
              "CreateSecurityGroup",
              "CreateNetworkAcl",
            ],
          },
        },
      }),
    );
    cloudFormationRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["secretsmanager:GetRandomPassword"],
        resources: ["*"],
      }),
    );
    cloudFormationRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "ec2:DescribeAvailabilityZones",
          "ec2:DescribeVpcs",
          "ec2:DescribeVpcAttribute",
          "ec2:DescribeSubnets",
          "ec2:DescribeRouteTables",
          "ec2:DescribeInternetGateways",
          "ec2:DescribeSecurityGroups",
          "ec2:DescribeNetworkAcls",
        ],
        resources: ["*"],
      }),
    );
    cloudFormationRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ecs:DescribeClusters"],
        resources: [`arn:aws:ecs:${this.region}:${this.account}:cluster/${prefix}-cluster`],
      }),
    );
    cloudFormationRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ecs:DescribeServices"],
        resources: [`arn:aws:ecs:${this.region}:${this.account}:service/${prefix}-cluster/${prefix}-service`],
      }),
    );
    cloudFormationRole.addToPolicy(
      new iam.PolicyStatement({
        // ECS evaluates CloudFormation deregistration against resource "*".
        // This service-only role can be passed solely to the two exact
        // run-scoped stacks, so the wildcard cannot be exercised directly by
        // the staging deployer.
        actions: ["ecs:DeregisterTaskDefinition"],
        resources: ["*"],
      }),
    );
    cloudFormationRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "elasticloadbalancing:DescribeLoadBalancers",
          "elasticloadbalancing:DescribeTargetGroups",
          "elasticloadbalancing:DescribeListeners",
          "elasticloadbalancing:DescribeRules",
          "elasticloadbalancing:DescribeTags",
          "elasticloadbalancing:DescribeTargetHealth",
        ],
        resources: ["*"],
      }),
    );
    cloudFormationRole.addToPolicy(
      new iam.PolicyStatement({
        // ELB listeners created by CloudFormation may not retain stack tags
        // when the service retries listener creation without tag-on-create.
        // Keep teardown bounded to the exact run-scoped ALB listener ARN.
        actions: ["elasticloadbalancing:DeleteListener"],
        resources: [
          `arn:aws:elasticloadbalancing:${this.region}:${this.account}:listener/app/mcv1-${props.runId}-alb/*/*`,
        ],
      }),
    );
    cloudFormationRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["rds:DescribeDBInstances", "rds:DescribeDBSubnetGroups"],
        resources: ["*"],
      }),
    );
    cloudFormationRole.addToPolicy(
      new iam.PolicyStatement({
        // CloudFormation resolves AWS::Logs::LogGroup Arn attributes through this
        // account-scoped read API, which does not support resource-level IAM.
        actions: ["logs:DescribeLogGroups"],
        resources: ["*"],
      }),
    );
    cloudFormationRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "logs:CreateLogGroup",
          "logs:DeleteLogGroup",
          "logs:PutRetentionPolicy",
          "logs:DeleteRetentionPolicy",
          "logs:TagResource",
          "logs:UntagResource",
        ],
        resources: [
          `arn:aws:logs:${this.region}:${this.account}:log-group:/wallyweb/${prefix}`,
          `arn:aws:logs:${this.region}:${this.account}:log-group:/wallyweb/${prefix}:*`,
        ],
      }),
    );
    cloudFormationRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ec2:*", "ecs:*", "ecr:*", "rds:*", "secretsmanager:*", "elasticloadbalancing:*", "logs:*", "acm:*"],
        resources: ["*"],
        conditions: resourceTagConditions,
      }),
    );
    cloudFormationRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        actions: [
          "kms:*",
          "lambda:*",
          "iam:CreateRole",
          "iam:DeleteRole",
          "iam:UpdateAssumeRolePolicy",
          "iam:PutRolePolicy",
          "iam:DeleteRolePolicy",
          "iam:AttachRolePolicy",
          "iam:DetachRolePolicy",
          "iam:PassRole",
          "sts:AssumeRole",
          "logs:DeleteLogGroup",
          "logs:PutRetentionPolicy",
          "cloudformation:UpdateStack",
          "cloudformation:DeleteStack",
        ],
        resources: [
          props.attestationKeyArn,
          props.signerFunctionArn,
          `${props.signerFunctionArn}:*`,
          props.signerRoleArn,
          `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/mcv1-${props.runId}-signer:*`,
          `arn:aws:cloudformation:${this.region}:${this.account}:stack/${prefix}-authority/*`,
        ],
      }),
    );
    cloudFormationRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["iam:CreateRole"],
        resources: [
          ...["task", "execution", "probe", "collector"].map(
            (suffix) => `arn:aws:iam::${this.account}:role/${prefix}-${suffix}`,
          ),
        ],
        conditions: { StringEquals: { "iam:PermissionsBoundary": permissionsBoundary.managedPolicyArn } },
      }),
    );
    cloudFormationRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["iam:DeleteRole", "iam:GetRole", "iam:TagRole", "iam:UntagRole"],
        resources: ["task", "execution", "probe", "collector"].map(
          (suffix) => `arn:aws:iam::${this.account}:role/${prefix}-${suffix}`,
        ),
      }),
    );
    cloudFormationRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["iam:GetPolicy"],
        resources: [permissionsBoundary.managedPolicyArn],
      }),
    );
    cloudFormationRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:GetRolePolicy", "iam:PassRole"],
        resources: ["task", "execution", "probe", "collector"].map(
          (suffix) => `arn:aws:iam::${this.account}:role/${prefix}-${suffix}`,
        ),
      }),
    );
    cloudFormationRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        actions: ["iam:DeleteRolePermissionsBoundary", "iam:PutRolePermissionsBoundary"],
        resources: ["task", "execution", "probe", "collector"].map(
          (suffix) => `arn:aws:iam::${this.account}:role/${prefix}-${suffix}`,
        ),
      }),
    );
    cloudFormationRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:*"],
        resources: [
          `arn:aws:s3:::mc-v1-stage-${props.runId}-${this.account}`,
          `arn:aws:s3:::mc-v1-stage-${props.runId}-${this.account}/*`,
        ],
      }),
    );
    cloudFormationRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["iam:GetRole", "ec2:DescribeAvailabilityZones"],
        resources: ["*"],
      }),
    );

    deployerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "cloudformation:CreateStack",
          "cloudformation:UpdateStack",
          "cloudformation:DeleteStack",
          "cloudformation:DescribeStacks",
          "cloudformation:DescribeStackEvents",
          "cloudformation:DescribeStackResources",
          "cloudformation:ListStackResources",
          "cloudformation:GetTemplate",
        ],
        resources: ["bootstrap", "runtime"].map(
          (suffix) => `arn:aws:cloudformation:${this.region}:${this.account}:stack/${prefix}-${suffix}/*`,
        ),
      }),
    );
    deployerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [cloudFormationRole.roleArn],
        conditions: { StringEquals: { "iam:PassedToService": "cloudformation.amazonaws.com" } },
      }),
    );
    templateBucket.grantReadWrite(deployerRole, `templates/${props.runId}/*`);
    deployerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:ListBucketVersions"],
        resources: [`arn:aws:s3:::mc-v1-stage-${props.runId}-${this.account}`],
      }),
    );
    deployerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:DeleteObject", "s3:DeleteObjectVersion"],
        resources: [`arn:aws:s3:::mc-v1-stage-${props.runId}-${this.account}/*`],
      }),
    );
    deployerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["acm:ImportCertificate", "acm:AddTagsToCertificate"],
        resources: ["*"],
        conditions: tagConditions,
      }),
    );
    deployerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["acm:DescribeCertificate", "acm:ListTagsForCertificate", "acm:DeleteCertificate"],
        resources: ["*"],
        conditions: resourceTagConditions,
      }),
    );
    deployerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ecr:GetAuthorizationToken", "sts:GetCallerIdentity", "tag:GetResources"],
        resources: ["*"],
      }),
    );
    deployerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "ecr:BatchCheckLayerAvailability",
          "ecr:CompleteLayerUpload",
          "ecr:DescribeImages",
          "ecr:GetDownloadUrlForLayer",
          "ecr:InitiateLayerUpload",
          "ecr:PutImage",
          "ecr:UploadLayerPart",
          "ecr:BatchGetImage",
        ],
        resources: [`arn:aws:ecr:${this.region}:${this.account}:repository/${prefix}`],
      }),
    );
    deployerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "rds:DescribeDBInstances",
          "secretsmanager:DescribeSecret",
          "secretsmanager:GetSecretValue",
          "secretsmanager:PutSecretValue",
          "kms:DescribeKey",
          "kms:GetPublicKey",
          "kms:Verify",
        ],
        resources: [
          `arn:aws:rds:${this.region}:${this.account}:db:${prefix}-postgres`,
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${prefix}-*`,
          props.attestationKeyArn,
          props.signerFunctionArn,
        ],
        conditions: resourceTagConditions,
      }),
    );
    deployerRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        actions: [
          "kms:Sign",
          "kms:CreateGrant",
          "kms:PutKeyPolicy",
          "kms:DisableKey",
          "kms:ScheduleKeyDeletion",
          "kms:CancelKeyDeletion",
          "kms:EnableKey",
          "kms:TagResource",
          "kms:UntagResource",
          "lambda:UpdateFunctionCode",
          "lambda:UpdateFunctionConfiguration",
          "lambda:DeleteFunction",
          "lambda:InvokeFunction",
          "lambda:AddPermission",
          "lambda:RemovePermission",
          "iam:PassRole",
          "iam:UpdateAssumeRolePolicy",
          "iam:PutRolePolicy",
          "iam:AttachRolePolicy",
          "iam:DeleteRole",
          "sts:AssumeRole",
          "cloudformation:UpdateStack",
          "cloudformation:DeleteStack",
        ],
        resources: [
          props.attestationKeyArn,
          props.signerFunctionArn,
          `${props.signerFunctionArn}:*`,
          props.signerRoleArn,
          `arn:aws:cloudformation:${this.region}:${this.account}:stack/${prefix}-authority/*`,
        ],
      }),
    );
    deployerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [`arn:aws:iam::${this.account}:role/${prefix}-collector`],
      }),
    );
    deployerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["iam:ListRoleTags"],
        resources: ["task", "execution", "probe", "collector"].map(
          (suffix) => `arn:aws:iam::${this.account}:role/${prefix}-${suffix}`,
        ),
      }),
    );

    for (const [key, value] of Object.entries(exactTags)) cdk.Tags.of(this).add(key, value);
    new cdk.CfnOutput(this, "DeployerRoleArn", { value: deployerRole.roleArn });
    new cdk.CfnOutput(this, "CloudFormationRoleArn", { value: cloudFormationRole.roleArn });
    new cdk.CfnOutput(this, "TemplateBucketName", { value: templateBucket.bucketName });
    new cdk.CfnOutput(this, "WorkloadPermissionsBoundaryArn", {
      value: permissionsBoundary.managedPolicyArn,
      exportName: `${prefix}-WorkloadPermissionsBoundaryArn`,
    });
  }
}
