import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

type MissionControlAppStackProps = cdk.StackProps & { imageTag: string };

export class MissionControlAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MissionControlAppStackProps) {
    super(scope, id, props);

    const zone = route53.HostedZone.fromLookup(this, "Zone", { domainName: "wallyweb.com" });
    const vpc = ec2.Vpc.fromLookup(this, "Vpc", { isDefault: true });
    const certificate = new acm.Certificate(this, "Certificate", {
      domainName: "mission.wallyweb.com",
      validation: acm.CertificateValidation.fromDns(zone),
    });
    const table = new dynamodb.Table(this, "EventsTable", {
      tableName: "mission-control-production-events",
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: "expiresAt",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const agentToken = new secretsmanager.Secret(this, "AgentToken", {
      secretName: "mission-control/production/agent-token",
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });
    const repository = ecr.Repository.fromRepositoryName(this, "Repository", "mission-control");
    const cluster = new ecs.Cluster(this, "Cluster", { clusterName: "mission-control-production", vpc });
    const logGroup = new logs.LogGroup(this, "LogGroup", {
      logGroupName: "/ecs/mission-control-production",
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const service = new ecsPatterns.ApplicationLoadBalancedFargateService(this, "Service", {
      cluster,
      serviceName: "mission-control-web",
      desiredCount: 1,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      publicLoadBalancer: true,
      assignPublicIp: true,
      certificate,
      domainName: "mission.wallyweb.com",
      domainZone: zone,
      redirectHTTP: true,
      taskImageOptions: {
        image: ecs.ContainerImage.fromEcrRepository(repository, props.imageTag),
        containerName: "web",
        containerPort: 3000,
        enableLogging: true,
        logDriver: ecs.LogDrivers.awsLogs({ streamPrefix: "web", logGroup }),
        environment: {
          NODE_ENV: "production",
          PUBLIC_APP_URL: "https://mission.wallyweb.com",
          INTERNAL_AGENT_URL: "self",
          DEMO_MODE: "true",
          EVENT_STORE: "dynamodb",
          MISSION_EVENTS_TABLE: table.tableName,
          ENABLE_LIVE_CODEX: "false",
          AWS_REGION: this.region,
          DEMO_EVENT_TTL_DAYS: "7",
        },
        secrets: {
          MISSION_CONTROL_AGENT_TOKEN: ecs.Secret.fromSecretsManager(agentToken),
        },
      },
      circuitBreaker: { rollback: true },
      healthCheckGracePeriod: cdk.Duration.seconds(60),
    });
    service.targetGroup.configureHealthCheck({
      path: "/api/health",
      healthyHttpCodes: "200",
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(10),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
    });
    table.grantReadWriteData(service.taskDefinition.taskRole);
    agentToken.grantRead(service.taskDefinition.executionRole!);

    cdk.Tags.of(this).add("Project", "MissionControl");
    cdk.Tags.of(this).add("Environment", "Production");
    cdk.Tags.of(this).add("ManagedBy", "CDK");
    cdk.Tags.of(this).add("Owner", "WallyWeb");

    new cdk.CfnOutput(this, "ApplicationUrl", { value: "https://mission.wallyweb.com" });
    new cdk.CfnOutput(this, "EventsTableName", { value: table.tableName });
    new cdk.CfnOutput(this, "ServiceName", { value: service.service.serviceName });
  }
}
