import * as cdk from "aws-cdk-lib";
import * as certificatemanager from "aws-cdk-lib/aws-certificatemanager";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elasticloadbalancingv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

export type MissionControlV1StagingBootstrapStackProps = cdk.StackProps & {
  runId: string;
  operatorRoleArn: string;
  operatorIpv4Cidr: string;
  certificateArn: string;
  attestationKeyArn: string;
  signerFunctionArn: string;
};

const runIdPattern = /^[a-z0-9][a-z0-9-]{7,15}$/;
const basePrefix = "mission-control-v1-staging";
const stagingTags = (runId: string) => ({
  Environment: "staging",
  Project: "mission-control",
  Purpose: "v1-external-acceptance",
  Disposable: "true",
  ProductionAccess: "false",
  StagingRunId: runId,
});

export class MissionControlV1StagingBootstrapStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MissionControlV1StagingBootstrapStackProps) {
    super(scope, id, props);
    const prefix = `${basePrefix}-${props.runId}`;
    const workloadBoundary = iam.ManagedPolicy.fromManagedPolicyArn(
      this,
      "WorkloadBoundary",
      cdk.Fn.importValue(`${prefix}-WorkloadPermissionsBoundaryArn`),
    );
    const exactDeployerArn = `arn:aws:iam::${this.account}:role/${prefix}-deployer`;
    if (
      !runIdPattern.test(props.runId) ||
      props.operatorRoleArn !== exactDeployerArn ||
      !/^(?:\d{1,3}\.){3}\d{1,3}\/32$/.test(props.operatorIpv4Cidr) ||
      !props.certificateArn.startsWith(`arn:aws:acm:${this.region}:${this.account}:certificate/`) ||
      !new RegExp(`^arn:aws:kms:${this.region}:${this.account}:key/[a-f0-9-]+$`).test(props.attestationKeyArn) ||
      props.signerFunctionArn !== `arn:aws:lambda:${this.region}:${this.account}:function:mcv1-${props.runId}-signer`
    )
      throw new Error("Staging bootstrap requires the exact staging deployer, /32 CIDR, and staging certificate.");
    const exports = (name: string) => `${prefix}-${name}`;
    const certificate = certificatemanager.Certificate.fromCertificateArn(this, "Certificate", props.certificateArn);

    const vpc = new ec2.Vpc(this, "Vpc", {
      vpcName: `${prefix}-vpc`,
      ipAddresses: ec2.IpAddresses.cidr("10.73.0.0/20"),
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: `${prefix}-public`, subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    });
    const databaseSecurityGroup = new ec2.SecurityGroup(this, "DatabaseSecurityGroup", {
      vpc,
      securityGroupName: `${prefix}-database-sg`,
      description: "Disposable V1 staging PostgreSQL access",
      allowAllOutbound: false,
    });
    databaseSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(props.operatorIpv4Cidr),
      ec2.Port.tcp(5432),
      "Exact staging migration source",
    );
    const taskSecurityGroup = new ec2.SecurityGroup(this, "TaskSecurityGroup", {
      vpc,
      securityGroupName: `${prefix}-task-sg`,
      description: "Disposable V1 staging task boundary",
      allowAllOutbound: true,
    });
    databaseSecurityGroup.addIngressRule(taskSecurityGroup, ec2.Port.tcp(5432), "Exact staging task");
    const loadBalancerSecurityGroup = new ec2.SecurityGroup(this, "LoadBalancerSecurityGroup", {
      vpc,
      securityGroupName: `${prefix}-alb-sg`,
      description: "Disposable V1 staging HTTPS boundary",
      allowAllOutbound: false,
    });
    loadBalancerSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(props.operatorIpv4Cidr),
      ec2.Port.tcp(443),
      "Exact external acceptance source",
    );
    loadBalancerSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(443),
      "Disposable VPC HTTPS probe",
    );
    loadBalancerSecurityGroup.addEgressRule(taskSecurityGroup, ec2.Port.tcp(3000), "Exact staging target");
    taskSecurityGroup.addIngressRule(loadBalancerSecurityGroup, ec2.Port.tcp(3000), "Exact staging load balancer");

    const databaseName = `mission_control_v1_staging_${props.runId.replaceAll("-", "_")}`;
    const database = new rds.DatabaseInstance(this, "Database", {
      databaseName,
      instanceIdentifier: `${prefix}-postgres`,
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_17_6 }),
      caCertificate: rds.CaCertificate.RDS_CA_RSA2048_G1,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      credentials: rds.Credentials.fromGeneratedSecret("mission_control_staging_admin", {
        secretName: `${prefix}-database-admin`,
      }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [databaseSecurityGroup],
      publiclyAccessible: true,
      multiAz: false,
      allocatedStorage: 20,
      maxAllocatedStorage: 20,
      storageEncrypted: true,
      backupRetention: cdk.Duration.days(0),
      deletionProtection: false,
      autoMinorVersionUpgrade: false,
      deleteAutomatedBackups: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const repository = new ecr.Repository(this, "Repository", {
      repositoryName: prefix,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      emptyOnDelete: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const evidenceBucket = new s3.Bucket(this, "EvidenceBucket", {
      bucketName: `mc-v1-stage-${props.runId}-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const runtimeSecret = new secretsmanager.Secret(this, "RuntimeSecret", {
      secretName: `${prefix}-runtime`,
      description: `Disposable V1 staging runtime configuration ${props.runId}`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ schemaVersion: "mission-control-v1-staging-runtime-secret/1" }),
        generateStringKey: "sessionSecret",
        passwordLength: 64,
        excludePunctuation: true,
      },
    });
    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      clusterName: `${prefix}-cluster`,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });
    const logGroup = new logs.LogGroup(this, "Logs", {
      logGroupName: `/wallyweb/${prefix}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const taskRole = new iam.Role(this, "TaskRole", {
      roleName: `${prefix}-task`,
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      permissionsBoundary: workloadBoundary,
    });
    const executionRole = new iam.Role(this, "ExecutionRole", {
      roleName: `${prefix}-execution`,
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      permissionsBoundary: workloadBoundary,
    });
    const probeRole = new iam.Role(this, "ProbeRole", {
      roleName: `${prefix}-probe`,
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      permissionsBoundary: workloadBoundary,
    });
    const collectorRole = new iam.Role(this, "CollectorRole", {
      roleName: `${prefix}-collector`,
      assumedBy: new iam.PrincipalWithConditions(new iam.AccountPrincipal(this.account), {
        ArnEquals: { "aws:PrincipalArn": props.operatorRoleArn },
      }),
      maxSessionDuration: cdk.Duration.hours(1),
      permissionsBoundary: workloadBoundary,
    });
    collectorRole.addToPolicy(
      new iam.PolicyStatement({ effect: iam.Effect.DENY, actions: ["kms:Sign"], resources: ["*"] }),
    );
    collectorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["kms:DescribeKey", "kms:GetPublicKey", "kms:Verify"],
        resources: [props.attestationKeyArn],
      }),
    );
    collectorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [props.signerFunctionArn],
      }),
    );
    collectorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ecr:BatchGetImage", "ecr:DescribeImages"],
        resources: [repository.repositoryArn],
      }),
    );
    collectorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["rds:DescribeDBInstances"],
        resources: [database.instanceArn],
      }),
    );
    collectorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"],
        resources: [runtimeSecret.secretArn],
      }),
    );
    collectorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ecs:DescribeServices"],
        resources: [`arn:aws:ecs:${this.region}:${this.account}:service/${prefix}-cluster/${prefix}-service`],
      }),
    );
    collectorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ecs:ListTasks"],
        resources: ["*"],
        conditions: { ArnEquals: { "ecs:cluster": cluster.clusterArn } },
      }),
    );
    collectorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ecs:DescribeTasks"],
        resources: [`arn:aws:ecs:${this.region}:${this.account}:task/${prefix}-cluster/*`],
      }),
    );
    collectorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ecs:DescribeTaskDefinition", "elasticloadbalancing:DescribeTargetHealth"],
        resources: ["*"],
      }),
    );
    collectorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["logs:GetLogEvents", "logs:FilterLogEvents", "logs:DescribeLogStreams"],
        resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/wallyweb/${prefix}:*`],
      }),
    );
    collectorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ecs:RunTask"],
        resources: [`arn:aws:ecs:${this.region}:${this.account}:task-definition/${prefix}-https-probe:*`],
        conditions: { ArnEquals: { "ecs:cluster": cluster.clusterArn } },
      }),
    );
    collectorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [probeRole.roleArn, executionRole.roleArn],
        conditions: { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } },
      }),
    );

    const loadBalancer = new elasticloadbalancingv2.ApplicationLoadBalancer(this, "LoadBalancer", {
      vpc,
      internetFacing: true,
      loadBalancerName: `mcv1-${props.runId}-alb`,
      securityGroup: loadBalancerSecurityGroup,
      vpcSubnets: { subnets: vpc.publicSubnets },
    });
    const targetGroup = new elasticloadbalancingv2.ApplicationTargetGroup(this, "TargetGroup", {
      vpc,
      targetGroupName: `mcv1-${props.runId}-target`,
      protocol: elasticloadbalancingv2.ApplicationProtocol.HTTP,
      port: 3000,
      targetType: elasticloadbalancingv2.TargetType.IP,
      healthCheck: { path: "/api/health", port: "3000", healthyHttpCodes: "200" },
    });
    loadBalancer.addListener("HttpsListener", {
      port: 443,
      protocol: elasticloadbalancingv2.ApplicationProtocol.HTTPS,
      certificates: [certificate],
      defaultTargetGroups: [targetGroup],
    });

    for (const [key, value] of Object.entries(stagingTags(props.runId))) cdk.Tags.of(this).add(key, value);
    const output = (id: string, value: string, exportName = id) =>
      new cdk.CfnOutput(this, id, { value, exportName: exports(exportName) });
    output("VpcId", vpc.vpcId);
    output("PublicSubnetIds", vpc.publicSubnets.map(({ subnetId }) => subnetId).join(","));
    output("AvailabilityZones", vpc.publicSubnets.map(({ availabilityZone }) => availabilityZone).join(","));
    output("RouteTableIds", vpc.publicSubnets.map(({ routeTable }) => routeTable.routeTableId).join(","));
    output("DatabaseArn", database.instanceArn);
    output("DatabaseIdentifier", database.instanceIdentifier);
    output("DatabaseEndpoint", database.dbInstanceEndpointAddress);
    output("DatabasePort", database.dbInstanceEndpointPort);
    output("DatabaseName", databaseName);
    output("DatabaseSecretArn", database.secret!.secretArn);
    output("RuntimeSecretArn", runtimeSecret.secretArn);
    output("DatabaseSecurityGroupId", databaseSecurityGroup.securityGroupId);
    output("TaskSecurityGroupId", taskSecurityGroup.securityGroupId);
    output("LoadBalancerSecurityGroupId", loadBalancerSecurityGroup.securityGroupId);
    output("RepositoryName", repository.repositoryName);
    output("RepositoryArn", repository.repositoryArn);
    output("RepositoryUri", repository.repositoryUri);
    output("EvidenceBucketName", evidenceBucket.bucketName);
    output("EvidenceBucketArn", evidenceBucket.bucketArn);
    output("AttestationKeyArn", props.attestationKeyArn);
    output("SignerFunctionArn", props.signerFunctionArn);
    output("ClusterArn", cluster.clusterArn);
    output("ClusterName", cluster.clusterName);
    output("LogGroupName", logGroup.logGroupName);
    output("LogGroupArn", logGroup.logGroupArn);
    output("TaskRoleArn", taskRole.roleArn);
    output("ExecutionRoleArn", executionRole.roleArn);
    output("ProbeRoleArn", probeRole.roleArn);
    output("CollectorRoleArn", collectorRole.roleArn);
    output("CertificateArn", props.certificateArn);
    output("LoadBalancerArn", loadBalancer.loadBalancerArn);
    output("LoadBalancerDnsName", loadBalancer.loadBalancerDnsName);
    output("TargetGroupArn", targetGroup.targetGroupArn);
  }
}
