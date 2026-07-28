import * as cdk from "aws-cdk-lib";
import * as certificatemanager from "aws-cdk-lib/aws-certificatemanager";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

export type MissionControlV1EcsStackProps = cdk.StackProps & {
  vpcId: string;
  availabilityZones: string[];
  publicSubnetIds: string[];
  webImageDigest: string;
  projectBrainImageDigest: string;
  databaseSecretArn: string;
  runtimeSecretArn: string;
  artifactBucketName: string;
  certificateArn: string;
  productionConfigurationDigest: string;
  applicationCommit: string;
  buildIdentityDigest: string;
};

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const shaPattern = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;

export class MissionControlV1EcsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MissionControlV1EcsStackProps) {
    super(scope, id, props);
    if (
      !digestPattern.test(props.webImageDigest) ||
      !digestPattern.test(props.projectBrainImageDigest) ||
      !shaPattern.test(props.productionConfigurationDigest) ||
      !shaPattern.test(props.buildIdentityDigest) ||
      !commitPattern.test(props.applicationCommit)
    )
      throw new Error("V1 ECS deployment requires immutable image, configuration, build, and source identities.");
    if (props.availabilityZones.length === 0 || props.availabilityZones.length !== props.publicSubnetIds.length)
      throw new Error("V1 ECS deployment requires explicit matching availability zones and public subnets.");

    const vpc = ec2.Vpc.fromVpcAttributes(this, "Vpc", {
      vpcId: props.vpcId,
      availabilityZones: props.availabilityZones,
      publicSubnetIds: props.publicSubnetIds,
    });
    const repository = ecr.Repository.fromRepositoryName(this, "Repository", "mission-control");
    const artifacts = s3.Bucket.fromBucketName(this, "Artifacts", props.artifactBucketName);
    const databaseSecret = secretsmanager.Secret.fromSecretCompleteArn(this, "DatabaseSecret", props.databaseSecretArn);
    const runtimeSecret = secretsmanager.Secret.fromSecretCompleteArn(this, "RuntimeSecret", props.runtimeSecretArn);
    const certificate = certificatemanager.Certificate.fromCertificateArn(this, "Certificate", props.certificateArn);
    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      clusterName: "mission-control-v1-production",
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });
    const taskRole = new iam.Role(this, "TaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "Least-privilege Mission Control v1 application task role",
    });
    const executionRole = new iam.Role(this, "ExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "Mission Control v1 image-pull and log-delivery role",
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSTaskExecutionRolePolicy")],
    });
    databaseSecret.grantRead(executionRole);
    runtimeSecret.grantRead(executionRole);
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:PutObject"],
        resources: [`${artifacts.bucketArn}/production/v1/*`],
      }),
    );
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:ListBucket"],
        resources: [artifacts.bucketArn],
        conditions: { StringLike: { "s3:prefix": ["production/v1/*"] } },
      }),
    );
    const taskDefinition = new ecs.FargateTaskDefinition(this, "TaskDefinition", {
      cpu: 1024,
      memoryLimitMiB: 2048,
      taskRole,
      executionRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    const logGroup = new logs.LogGroup(this, "Logs", {
      logGroupName: "/wallyweb/mission-control/v1-production",
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const commonEnvironment = {
      APP_ENV: "production",
      NODE_ENV: "production",
      PROJECT_BRAIN_LOCAL_EXECUTION: "disabled",
      ARTIFACT_STORAGE_PROVIDER: "s3",
      ARTIFACT_S3_BUCKET: props.artifactBucketName,
      ARTIFACT_S3_REGION: this.region,
      ARTIFACT_S3_ENDPOINT: `https://s3.${this.region}.amazonaws.com`,
      ARTIFACT_S3_USE_IAM_ROLE: "true",
      ARTIFACT_S3_PREFIX: "production/v1",
      MC_V1_PRODUCTION_CONTRACT_VERSION: "mission-control-production-rollout-v1",
      MC_V1_PRODUCTION_CONFIGURATION_DIGEST: props.productionConfigurationDigest,
      MC_V1_APPLICATION_COMMIT: props.applicationCommit,
      MC_V1_BUILD_IDENTITY_DIGEST: props.buildIdentityDigest,
      MC_V1_EXPECTED_DESIRED_COUNT: "1",
    };
    const commonSecrets = {
      DATABASE_URL: ecs.Secret.fromSecretsManager(databaseSecret, "databaseUrl"),
    };
    const web = taskDefinition.addContainer("web", {
      image: ecs.ContainerImage.fromEcrRepository(repository, props.webImageDigest),
      essential: true,
      cpu: 512,
      memoryLimitMiB: 768,
      environment: {
        ...commonEnvironment,
        PUBLIC_APP_URL: "https://app.missioncontrol.wallyweb.com",
        SECURE_COOKIES: "true",
      },
      secrets: {
        ...commonSecrets,
        V1_CONTROLLER_DATABASE_URL: ecs.Secret.fromSecretsManager(databaseSecret, "v1ControllerDatabaseUrl"),
        MISSION_CONTROL_SESSION_SECRET: ecs.Secret.fromSecretsManager(runtimeSecret, "sessionSecret"),
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "web" }),
      healthCheck: {
        command: [
          "CMD-SHELL",
          "node -e \"fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"",
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });
    web.addPortMappings({ containerPort: 3000, protocol: ecs.Protocol.TCP });
    taskDefinition.addContainer("generic-worker", {
      image: ecs.ContainerImage.fromEcrRepository(repository, props.webImageDigest),
      essential: true,
      cpu: 128,
      memoryLimitMiB: 256,
      command: ["node", "node_modules/tsx/dist/cli.mjs", "scripts/worker.ts"],
      environment: { ...commonEnvironment, PROCESS_TYPE: "generic", WORKER_ID: "mc-v1-generic" },
      secrets: commonSecrets,
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "generic-worker" }),
    });
    taskDefinition.addContainer("project-brain-worker", {
      image: ecs.ContainerImage.fromEcrRepository(repository, props.projectBrainImageDigest),
      essential: true,
      cpu: 256,
      memoryLimitMiB: 640,
      command: ["node", "node_modules/tsx/dist/cli.mjs", "scripts/project-brain-worker.ts"],
      environment: {
        ...commonEnvironment,
        PROCESS_TYPE: "project_brain",
        WORKER_ID: "mc-v1-project-brain",
        CODEX_REPOSITORY_ROOT: "/repositories",
        PROJECT_BRAIN_EXECUTABLE: "/opt/project-brain/bin/project-brain",
        PROJECT_BRAIN_REQUIRED_VERSION: "0.4.0",
        PROJECT_BRAIN_CONTRACT_VERSION: "1.0",
        PROJECT_BRAIN_TIMEOUT_MS: "15000",
        PROJECT_BRAIN_MAX_OUTPUT_BYTES: "1000000",
      },
      secrets: commonSecrets,
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "project-brain-worker" }),
    });
    taskDefinition.addContainer("remote-agent-worker", {
      image: ecs.ContainerImage.fromEcrRepository(repository, props.webImageDigest),
      essential: true,
      cpu: 128,
      memoryLimitMiB: 256,
      command: ["node", "node_modules/tsx/dist/cli.mjs", "scripts/remote-agent-worker.ts"],
      environment: {
        ...commonEnvironment,
        PROCESS_TYPE: "remote_agent",
        WORKER_ID: "mc-v1-remote-agent",
      },
      secrets: commonSecrets,
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "remote-agent-worker" }),
    });

    const service = new ecsPatterns.ApplicationLoadBalancedFargateService(this, "Service", {
      cluster,
      taskDefinition,
      desiredCount: 1,
      assignPublicIp: true,
      publicLoadBalancer: true,
      protocol: cdk.aws_elasticloadbalancingv2.ApplicationProtocol.HTTPS,
      listenerPort: 443,
      certificate,
      redirectHTTP: true,
      taskSubnets: {
        subnets: props.publicSubnetIds.map((subnetId, index) =>
          ec2.Subnet.fromSubnetAttributes(this, `PublicSubnet${index + 1}`, {
            subnetId,
            availabilityZone: props.availabilityZones[index],
          }),
        ),
      },
    });
    const cfnService = service.service.node.defaultChild as ecs.CfnService;
    cfnService.addPropertyOverride("DeploymentConfiguration.MaximumPercent", 100);
    cfnService.addPropertyOverride("DeploymentConfiguration.MinimumHealthyPercent", 0);
    service.targetGroup.configureHealthCheck({ path: "/api/health", healthyHttpCodes: "200" });

    for (const target of [this, cluster, service.service, taskDefinition]) {
      cdk.Tags.of(target).add("Project", "MissionControl");
      cdk.Tags.of(target).add("Environment", "Production");
      cdk.Tags.of(target).add("Contract", "mission-control-production-rollout-v1");
    }
    new cdk.CfnOutput(this, "ClusterArn", { value: cluster.clusterArn });
    new cdk.CfnOutput(this, "ServiceArn", { value: service.service.serviceArn });
    new cdk.CfnOutput(this, "TaskDefinitionArn", { value: taskDefinition.taskDefinitionArn });
    new cdk.CfnOutput(this, "LoadBalancerDnsName", { value: service.loadBalancer.loadBalancerDnsName });
  }
}
