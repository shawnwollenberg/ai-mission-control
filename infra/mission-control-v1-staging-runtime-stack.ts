import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elasticloadbalancingv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import {
  assertV1StagingBootstrapManifestDigest,
  type V1StagingBootstrapManifest,
} from "../application/v1-staging-bootstrap-manifest";

export type MissionControlV1StagingRuntimeStackProps = cdk.StackProps & {
  runId: string;
  bootstrapManifest: V1StagingBootstrapManifest;
  bootstrapManifestDigest: string;
  webImageDigest: string;
  projectBrainImageDigest: string;
  stagingConfigurationDigest: string;
  applicationCommit: string;
  buildIdentityDigest: string;
  projectBrainBuildIdentityDigest: string;
  stagingCertificateDerSha256: string;
};

const basePrefix = "mission-control-v1-staging";
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const shaPattern = /^[a-f0-9]{64}$/;

export class MissionControlV1StagingRuntimeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MissionControlV1StagingRuntimeStackProps) {
    super(scope, id, props);
    assertV1StagingBootstrapManifestDigest(props.bootstrapManifest, props.bootstrapManifestDigest);
    const prefix = `${basePrefix}-${props.runId}`;
    const resources = props.bootstrapManifest.resources;
    const namedRole = (suffix: string) => {
      const matches = resources.iamRoles.filter(({ name, arn }) => name === `${prefix}-${suffix}` && arn);
      if (matches.length !== 1) throw new Error(`Bootstrap manifest lacks exact ${suffix} role.`);
      return matches[0].arn!;
    };
    const namedSecurityGroup = (suffix: string) => {
      const matches = resources.securityGroups.filter(({ name }) => name === `${prefix}-${suffix}`);
      if (matches.length !== 1) throw new Error(`Bootstrap manifest lacks exact ${suffix} security group.`);
      return matches[0].id;
    };
    const runtimeSecrets = props.bootstrapManifest.resources.secrets.filter(({ name }) => name === `${prefix}-runtime`);
    const runtimeSecretArn = runtimeSecrets[0]?.arn;
    if (
      props.bootstrapManifest.runId !== props.runId ||
      props.bootstrapManifest.accountId !== this.account ||
      props.bootstrapManifest.region !== this.region ||
      !digestPattern.test(props.webImageDigest) ||
      !digestPattern.test(props.projectBrainImageDigest) ||
      !shaPattern.test(props.stagingConfigurationDigest) ||
      !shaPattern.test(props.buildIdentityDigest) ||
      !shaPattern.test(props.projectBrainBuildIdentityDigest) ||
      !shaPattern.test(props.stagingCertificateDerSha256) ||
      !/^[a-f0-9]{40}$/.test(props.applicationCommit) ||
      runtimeSecrets.length !== 1 ||
      !runtimeSecretArn?.includes(`:secret:${prefix}-runtime-`)
    )
      throw new Error("V1 staging runtime refuses unbound, mutable, or cross-run identities.");

    const availabilityZones = resources.subnets.map(({ availabilityZone }) => availabilityZone);
    const publicSubnetIds = resources.subnets.map(({ id }) => id);
    const vpc = ec2.Vpc.fromVpcAttributes(this, "Vpc", {
      vpcId: resources.vpc.id,
      availabilityZones,
      publicSubnetIds,
    });
    const repository = ecr.Repository.fromRepositoryAttributes(this, "Repository", {
      repositoryArn: resources.ecrRepositories[0].arn!,
      repositoryName: resources.ecrRepositories[0].id,
    });
    const bucket = s3.Bucket.fromBucketAttributes(this, "EvidenceBucket", {
      bucketArn: resources.evidenceBucket.arn!,
      bucketName: resources.evidenceBucket.id,
    });
    const cluster = ecs.Cluster.fromClusterAttributes(this, "Cluster", {
      clusterArn: resources.ecsCluster.arn!,
      clusterName: resources.ecsCluster.id,
      vpc,
      securityGroups: [],
    });
    const logGroup = logs.LogGroup.fromLogGroupName(this, "Logs", resources.logGroup.id);
    const taskRole = iam.Role.fromRoleArn(this, "TaskRole", namedRole("task"), { mutable: true });
    const executionRole = iam.Role.fromRoleArn(this, "ExecutionRole", namedRole("execution"), { mutable: true });
    const probeRole = iam.Role.fromRoleArn(this, "ProbeRole", namedRole("probe"), { mutable: false });
    const collectorRole = iam.Role.fromRoleArn(this, "CollectorRole", namedRole("collector"), { mutable: true });
    const runtimeSecret = secretsmanager.Secret.fromSecretCompleteArn(this, "RuntimeSecret", runtimeSecretArn);
    const taskSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      "TaskSecurityGroup",
      namedSecurityGroup("task-sg"),
      { mutable: false },
    );
    const targetGroup = elasticloadbalancingv2.ApplicationTargetGroup.fromTargetGroupAttributes(this, "TargetGroup", {
      targetGroupArn: resources.targetGroup.arn!,
    });

    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:PutObject"],
        resources: [`${bucket.bucketArn}/staging/v1/artifacts/${props.runId}/*`],
      }),
    );
    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["s3:ListBucket"],
        resources: [bucket.bucketArn],
      }),
    );
    executionRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"],
        resources: [repository.repositoryArn],
      }),
    );
    executionRole.addToPrincipalPolicy(
      new iam.PolicyStatement({ actions: ["ecr:GetAuthorizationToken"], resources: ["*"] }),
    );
    executionRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [`${logGroup.logGroupArn}:*`],
      }),
    );
    runtimeSecret.grantRead(executionRole);

    const taskDefinition = new ecs.FargateTaskDefinition(this, "TaskDefinition", {
      family: `${prefix}-task`,
      cpu: 1024,
      memoryLimitMiB: 2048,
      taskRole,
      executionRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    const commonEnvironment = {
      APP_ENV: "production",
      NODE_ENV: "production",
      SECRET_PROVIDER: "aws-secrets-manager",
      PROJECT_BRAIN_LOCAL_EXECUTION: "disabled",
      ARTIFACT_STORAGE_PROVIDER: "s3",
      ARTIFACT_S3_BUCKET: bucket.bucketName,
      ARTIFACT_S3_REGION: this.region,
      ARTIFACT_S3_ENDPOINT: `https://s3.${this.region}.amazonaws.com`,
      ARTIFACT_S3_USE_IAM_ROLE: "true",
      ARTIFACT_S3_PREFIX: `staging/v1/artifacts/${props.runId}`,
      MC_V1_PRODUCTION_CONTRACT_VERSION: "mission-control-production-rollout-v1",
      MC_V1_PRODUCTION_CONFIGURATION_DIGEST: props.stagingConfigurationDigest,
      MC_V1_APPLICATION_COMMIT: props.applicationCommit,
      MC_V1_BUILD_IDENTITY_DIGEST: props.buildIdentityDigest,
      MC_V1_EXPECTED_DESIRED_COUNT: "1",
      MC_V1_STAGING_ISOLATION: "required",
      MC_V1_STAGING_RUN_ID: props.runId,
      MC_V1_STAGING_BOOTSTRAP_MANIFEST_DIGEST: props.bootstrapManifestDigest,
      MC_V1_STAGING_AWS_ACCOUNT_ID: this.account,
      MC_V1_STAGING_AWS_REGION: this.region,
      // This staging-only deployment exercises the real production route gate.
      // The handlers still require authenticated, authorization-bound requests.
      MISSION_CONTROL_V1_PRODUCTION_ROUTES_ENABLED: "true",
      PUBLIC_APP_URL: `https://${resources.loadBalancer.dnsName}`,
      SECURE_COOKIES: "true",
    };
    const databaseSecret = { DATABASE_URL: ecs.Secret.fromSecretsManager(runtimeSecret, "databaseUrl") };
    const bindingSecrets = {
      MC_V1_STAGING_DATABASE_BINDING_RECEIPT: ecs.Secret.fromSecretsManager(runtimeSecret, "databaseBindingReceipt"),
      MC_V1_STAGING_ATTESTATION_PUBLIC_KEY: ecs.Secret.fromSecretsManager(runtimeSecret, "attestationPublicKey"),
    };
    const web = taskDefinition.addContainer("web", {
      image: ecs.ContainerImage.fromEcrRepository(repository, props.webImageDigest),
      essential: true,
      cpu: 512,
      memoryLimitMiB: 768,
      environment: { ...commonEnvironment, HOSTNAME: "0.0.0.0" },
      secrets: {
        ...databaseSecret,
        ...bindingSecrets,
        V1_CONTROLLER_DATABASE_URL: ecs.Secret.fromSecretsManager(runtimeSecret, "controllerDatabaseUrl"),
        MISSION_CONTROL_SESSION_SECRET: ecs.Secret.fromSecretsManager(runtimeSecret, "sessionSecret"),
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "web" }),
      healthCheck: {
        command: [
          "CMD",
          "node",
          "-e",
          "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
        ],
        interval: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(90),
      },
    });
    web.addPortMappings({ containerPort: 3000 });
    for (const [name, command, processType, cpu, memory] of [
      ["generic-worker", "scripts/worker.ts", "generic", 128, 256],
      ["remote-agent-worker", "scripts/remote-agent-worker.ts", "remote_agent", 128, 256],
    ] as const)
      taskDefinition.addContainer(name, {
        image: ecs.ContainerImage.fromEcrRepository(repository, props.webImageDigest),
        essential: true,
        cpu,
        memoryLimitMiB: memory,
        command: ["node", "node_modules/tsx/dist/cli.mjs", command],
        environment: {
          ...commonEnvironment,
          PROCESS_TYPE: processType,
          WORKER_ID: `${prefix}-${processType}`,
          ...(processType === "remote_agent" ? { AGENT_CREDENTIAL_PROVIDER: "postgres-verifier" } : {}),
        },
        secrets: { ...databaseSecret, ...bindingSecrets },
        logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: name }),
      });
    taskDefinition.addContainer("project-brain-worker", {
      image: ecs.ContainerImage.fromEcrRepository(repository, props.projectBrainImageDigest),
      essential: true,
      cpu: 256,
      memoryLimitMiB: 640,
      environment: {
        ...commonEnvironment,
        PROCESS_TYPE: "project_brain",
        WORKER_ID: `${prefix}-project-brain`,
        CODEX_REPOSITORY_ROOT: "/repositories",
        PROJECT_BRAIN_EXECUTABLE: "/opt/project-brain/bin/project-brain",
        PROJECT_BRAIN_REQUIRED_VERSION: "0.4.0",
        PROJECT_BRAIN_CONTRACT_VERSION: "1.0",
        PROJECT_BRAIN_TIMEOUT_MS: "15000",
        PROJECT_BRAIN_MAX_OUTPUT_BYTES: "1000000",
        MC_V1_BUILD_IDENTITY_DIGEST: props.projectBrainBuildIdentityDigest,
      },
      secrets: { ...databaseSecret, ...bindingSecrets },
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "project-brain-worker" }),
    });

    const service = new ecs.FargateService(this, "Service", {
      serviceName: `${prefix}-service`,
      cluster,
      taskDefinition,
      desiredCount: 1,
      assignPublicIp: true,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      securityGroups: [taskSecurityGroup],
      vpcSubnets: {
        subnets: publicSubnetIds.map((subnetId, index) =>
          ec2.Subnet.fromSubnetAttributes(this, `PublicSubnet${index + 1}`, {
            subnetId,
            availabilityZone: availabilityZones[index],
          }),
        ),
      },
    });
    service.attachToApplicationTargetGroup(targetGroup);

    const probeTaskDefinition = new ecs.FargateTaskDefinition(this, "HttpsProbeTaskDefinition", {
      family: `${prefix}-https-probe`,
      cpu: 256,
      memoryLimitMiB: 512,
      taskRole: probeRole,
      executionRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    probeTaskDefinition.addContainer("https-probe", {
      image: ecs.ContainerImage.fromEcrRepository(repository, props.webImageDigest),
      essential: true,
      command: [
        "node",
        "-e",
        "const h=require('https'),c=require('crypto'),host=process.env.PROBE_HOST,want=process.env.PROBE_CERT_DER_SHA256;const get=p=>new Promise((ok,no)=>{const q=h.get({host,path:p,port:443,rejectUnauthorized:false},r=>{const got=c.createHash('sha256').update(r.socket.getPeerCertificate(true).raw).digest('hex');r.resume();r.on('end',()=>r.statusCode===200&&got===want?ok({path:p,status:r.statusCode,cert:got}):no(new Error('probe_mismatch')))});q.on('error',no)});Promise.all(['/api/health','/api/readiness'].map(get)).then(x=>{console.log(JSON.stringify({event:'v1_vpc_https_leaf_pin_reachability_probe',tlsAuthority:'leaf-der-sha256-pin-only',satisfiesIndependentTlsAcceptance:false,results:x}));process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})",
      ],
      environment: {
        PROBE_HOST: resources.loadBalancer.dnsName,
        PROBE_CERT_DER_SHA256: props.stagingCertificateDerSha256,
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "https-probe" }),
    });

    collectorRole.addToPrincipalPolicy(
      new iam.PolicyStatement({ actions: ["ecs:DescribeServices"], resources: [service.serviceArn] }),
    );
    collectorRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["ecs:ListTasks"],
        resources: ["*"],
        conditions: { ArnEquals: { "ecs:cluster": cluster.clusterArn } },
      }),
    );
    collectorRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["ecs:DescribeTasks"],
        resources: [`arn:aws:ecs:${this.region}:${this.account}:task/${cluster.clusterName}/*`],
      }),
    );
    collectorRole.addToPrincipalPolicy(
      new iam.PolicyStatement({ actions: ["ecs:DescribeTaskDefinition"], resources: ["*"] }),
    );
    collectorRole.addToPrincipalPolicy(
      new iam.PolicyStatement({ actions: ["ecr:DescribeImages"], resources: [repository.repositoryArn] }),
    );
    collectorRole.addToPrincipalPolicy(
      new iam.PolicyStatement({ actions: ["elasticloadbalancing:DescribeTargetHealth"], resources: ["*"] }),
    );

    for (const [key, value] of Object.entries({
      Environment: "staging",
      Project: "mission-control",
      Purpose: "v1-external-acceptance",
      Disposable: "true",
      ProductionAccess: "false",
      StagingRunId: props.runId,
    }))
      cdk.Tags.of(this).add(key, value);
    new cdk.CfnOutput(this, "ServiceArn", { value: service.serviceArn });
    new cdk.CfnOutput(this, "TaskDefinitionArn", { value: taskDefinition.taskDefinitionArn });
    new cdk.CfnOutput(this, "HttpsProbeTaskDefinitionArn", { value: probeTaskDefinition.taskDefinitionArn });
  }
}
