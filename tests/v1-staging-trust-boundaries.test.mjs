import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import * as nodeCrypto from "node:crypto";
import test from "node:test";
import vm from "node:vm";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import {
  assertV1StagingBootstrapManifestDigest,
  v1StagingBootstrapManifestDigest,
} from "../application/v1-staging-bootstrap-manifest.ts";
import { canonicalJson } from "../application/v1-production-runtime-identity.ts";
import { verifyV1StagingDatabaseBinding } from "../lib/v1-staging-database-binding.ts";
import { MissionControlV1StagingBootstrapStack } from "../infra/mission-control-v1-staging-bootstrap-stack.ts";
import { MissionControlV1StagingAuthorityStack } from "../infra/mission-control-v1-staging-authority-stack.ts";
import { MissionControlV1StagingDeploymentStack } from "../infra/mission-control-v1-staging-deployment-stack.ts";
import { MissionControlV1StagingRuntimeStack } from "../infra/mission-control-v1-staging-runtime-stack.ts";
import { stagingSignerCode } from "../infra/mission-control-v1-staging-authority-stack.ts";

const now = Date.parse("2026-07-29T12:00:00.000Z");
const runId = "run-20260729-a1";
const prefix = `mission-control-v1-staging-${runId}`;
const signerFunctionArn = `arn:aws:lambda:us-east-1:661452835066:function:mcv1-${runId}-signer`;
const signerRoleArn = `arn:aws:iam::661452835066:role/${prefix}-authority-signer`;
const attestationKeyArn = "arn:aws:kms:us-east-1:661452835066:key/00000000-0000-0000-0000-000000000000";
const tags = {
  Environment: "staging",
  Project: "mission-control",
  Purpose: "v1-external-acceptance",
  Disposable: "true",
  ProductionAccess: "false",
  StagingRunId: runId,
};
const resource = (kind, id, arn) => ({
  kind,
  name: id,
  id,
  ...(arn ? { arn } : {}),
  createdAt: "2026-07-29T11:00:00.000Z",
  tags,
});
const manifest = {
  schemaVersion: "mission-control-v1-staging-bootstrap-manifest/1",
  runId,
  accountId: "661452835066",
  region: "us-east-1",
  observedAt: "2026-07-29T11:30:00.000Z",
  expiresAt: "2026-07-29T12:30:00.000Z",
  expectedConsumers: ["runtime-deployer", "database-binding-verifier", "attestation-signer"],
  resources: {
    vpc: resource("vpc", `${prefix}-vpc`),
    subnets: [
      { ...resource("subnet", `${prefix}-subnet-a`), availabilityZone: "us-east-1a" },
      { ...resource("subnet", `${prefix}-subnet-b`), availabilityZone: "us-east-1b" },
    ],
    routeTables: [resource("route-table", `${prefix}-route-a`), resource("route-table", `${prefix}-route-b`)],
    securityGroups: [
      resource("security-group", `${prefix}-database-sg`),
      resource("security-group", `${prefix}-task-sg`),
      resource("security-group", `${prefix}-alb-sg`),
    ],
    ecsCluster: resource(
      "ecs-cluster",
      `${prefix}-cluster`,
      `arn:aws:ecs:us-east-1:661452835066:cluster/${prefix}-cluster`,
    ),
    ecrRepositories: [resource("ecr-repository", prefix, `arn:aws:ecr:us-east-1:661452835066:repository/${prefix}`)],
    database: {
      ...resource("rds-instance", `${prefix}-postgres`, `arn:aws:rds:us-east-1:661452835066:db:${prefix}-postgres`),
      endpoint: `${prefix}-postgres.abc.us-east-1.rds.amazonaws.com`,
      port: 5432,
      databaseName: `mission_control_v1_staging_${runId.replaceAll("-", "_")}`,
    },
    kmsKey: resource("kms-key", `${prefix}-attestation`, `arn:aws:kms:us-east-1:661452835066:key/${prefix}`),
    evidenceBucket: resource("s3-bucket", `${prefix}-evidence`, `arn:aws:s3:::${prefix}-evidence`),
    secrets: [
      resource(
        "secret",
        `${prefix}-database-admin`,
        `arn:aws:secretsmanager:us-east-1:661452835066:secret:${prefix}-database-admin`,
      ),
      resource(
        "secret",
        `${prefix}-runtime`,
        `arn:aws:secretsmanager:us-east-1:661452835066:secret:${prefix}-runtime-abc123`,
      ),
    ],
    certificate: {
      ...resource("certificate", `${prefix}-certificate`, `arn:aws:acm:us-east-1:661452835066:certificate/${prefix}`),
      domainName: "*.us-east-1.elb.amazonaws.com",
    },
    loadBalancer: {
      ...resource(
        "load-balancer",
        `${prefix}-alb`,
        `arn:aws:elasticloadbalancing:us-east-1:661452835066:loadbalancer/app/${prefix}-alb/123`,
      ),
      dnsName: `mcv1-${runId}-alb-123.us-east-1.elb.amazonaws.com`,
      scheme: "internet-facing",
    },
    targetGroup: resource(
      "target-group",
      `${prefix}-target`,
      `arn:aws:elasticloadbalancing:us-east-1:661452835066:targetgroup/${prefix}-target/123`,
    ),
    logGroup: resource("log-group", `${prefix}-logs`, `arn:aws:logs:us-east-1:661452835066:log-group:/${prefix}`),
    iamRoles: ["task", "execution", "probe", "collector"].map((suffix) =>
      resource("iam-role", `${prefix}-${suffix}`, `arn:aws:iam::661452835066:role/${prefix}-${suffix}`),
    ),
  },
};

test("bootstrap manifest is canonical, digest-bound, run-bound, and fails closed for substitution", () => {
  const digest = v1StagingBootstrapManifestDigest(manifest, now);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assertV1StagingBootstrapManifestDigest(manifest, digest, now);
  const changed = structuredClone(manifest);
  changed.resources.vpc.id = "production-vpc";
  assert.throws(() => assertV1StagingBootstrapManifestDigest(changed, digest, now));
  const anotherRun = structuredClone(manifest);
  anotherRun.resources.vpc.tags.StagingRunId = "run-elsewhere";
  assert.throws(() => v1StagingBootstrapManifestDigest(anotherRun, now));
});

test("signed database binding accepts only exact verify-full staging authorities", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const manifestDigest = v1StagingBootstrapManifestDigest(manifest, now);
  const endpoint = `${prefix}-postgres.abc.us-east-1.rds.amazonaws.com`;
  const authority = (username) => ({
    hostname: endpoint,
    port: 5432,
    databaseName: `mission_control_v1_staging_${runId.replaceAll("-", "_")}`,
    username,
    tlsMode: "verify-full",
  });
  const unsigned = {
    schemaVersion: "mission-control-v1-staging-database-binding/1",
    runId,
    bootstrapManifestDigest: manifestDigest,
    observedAt: "2026-07-29T11:59:00.000Z",
    expiresAt: "2026-07-29T12:05:00.000Z",
    accountId: "661452835066",
    region: "us-east-1",
    rdsArn: `arn:aws:rds:us-east-1:661452835066:db:${prefix}-postgres`,
    resourceId: `${prefix}-postgres`,
    endpoint,
    port: 5432,
    databaseName: `mission_control_v1_staging_${runId.replaceAll("-", "_")}`,
    caIdentifier: "rds-ca-rsa2048-g1",
    schemaCompatibility: { minimum: "0028", maximum: "0030" },
    runtime: authority("mission_control_v1_staging_runtime"),
    controller: authority("mission_control_v1_staging_controller"),
  };
  const attestationRequest = {
    schemaVersion: "mission-control-v1-staging-attestation-request/1",
    kind: "database-binding",
    runId,
    accountId: "661452835066",
    region: "us-east-1",
    bootstrapManifestDigest: manifestDigest,
    observedAt: unsigned.observedAt,
    expiresAt: unsigned.expiresAt,
    nonce: "00000000-0000-4000-8000-000000000001",
    evidence: unsigned,
  };
  const receipt = {
    ...unsigned,
    attestationRequest,
    signature: sign(null, Buffer.from(canonicalJson(attestationRequest)), privateKey).toString("base64"),
  };
  const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const url = (username) =>
    `postgresql://${username}:redacted@${endpoint}:5432/${unsigned.databaseName}?sslmode=verify-full`;
  verifyV1StagingDatabaseBinding(
    receipt,
    spki,
    url("mission_control_v1_staging_runtime"),
    url("mission_control_v1_staging_controller"),
    { runId, manifestDigest, accountId: "661452835066", region: "us-east-1" },
    now,
  );
  assert.throws(() =>
    verifyV1StagingDatabaseBinding(
      receipt,
      spki,
      url("mission_control_v1_staging_runtime").replace(endpoint, "production.example"),
      undefined,
      { runId, manifestDigest, accountId: "661452835066", region: "us-east-1" },
      now,
    ),
  );
  assert.throws(() =>
    verifyV1StagingDatabaseBinding(
      { ...receipt, endpoint: "production.example" },
      spki,
      url("mission_control_v1_staging_runtime"),
      undefined,
      { runId, manifestDigest, accountId: "661452835066", region: "us-east-1" },
      now,
    ),
  );
});

test("staging infrastructure has one public HTTPS boundary with exact DNS, routing, and target ports", () => {
  const app = new App();
  const stack = new MissionControlV1StagingBootstrapStack(app, "Bootstrap", {
    env: { account: "661452835066", region: "us-east-1" },
    runId,
    operatorRoleArn: `arn:aws:iam::661452835066:role/${prefix}-deployer`,
    operatorIpv4Cidr: "203.0.113.1/32",
    certificateArn: "arn:aws:acm:us-east-1:661452835066:certificate/00000000-0000-0000-0000-000000000000",
    signerFunctionArn,
    attestationKeyArn,
  });
  const rendered = Template.fromStack(stack).toJSON();
  const resources = Object.values(rendered.Resources);
  const loadBalancers = resources.filter(({ Type }) => Type === "AWS::ElasticLoadBalancingV2::LoadBalancer");
  const listeners = resources.filter(({ Type }) => Type === "AWS::ElasticLoadBalancingV2::Listener");
  const targetGroups = resources.filter(({ Type }) => Type === "AWS::ElasticLoadBalancingV2::TargetGroup");
  const routes = resources.filter(({ Type }) => Type === "AWS::EC2::Route");
  assert.equal(loadBalancers.length, 1);
  assert.equal(loadBalancers[0].Properties.Scheme, "internet-facing");
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0].Properties.Port, 443);
  assert.equal(listeners[0].Properties.Protocol, "HTTPS");
  assert.equal(targetGroups.length, 1);
  assert.equal(targetGroups[0].Properties.Port, 3000);
  assert.equal(targetGroups[0].Properties.Protocol, "HTTP");
  assert.ok(routes.some(({ Properties }) => Properties.DestinationCidrBlock === "0.0.0.0/0" && Properties.GatewayId));
  assert.equal(listeners[0].Properties.Certificates.length, 1);
  const ingressRules = [
    ...resources.filter(({ Type }) => Type === "AWS::EC2::SecurityGroupIngress").map(({ Properties }) => Properties),
    ...resources
      .filter(({ Type }) => Type === "AWS::EC2::SecurityGroup")
      .flatMap(({ Properties }) => Properties.SecurityGroupIngress ?? []),
  ];
  assert.ok(ingressRules.some(({ FromPort, ToPort }) => FromPort === 443 && ToPort === 443));
  assert.ok(ingressRules.some(({ FromPort, ToPort }) => FromPort === 3000 && ToPort === 3000));
});

test("runtime consumes bootstrap exports and binds externally visible hostname to the exact TLS record", () => {
  const observed = new Date();
  const runtimeManifest = structuredClone(manifest);
  runtimeManifest.observedAt = observed.toISOString();
  runtimeManifest.expiresAt = new Date(observed.getTime() + 60 * 60_000).toISOString();
  for (const entry of [
    ...Object.values(runtimeManifest.resources).filter((entry) => entry && !Array.isArray(entry)),
    ...Object.values(runtimeManifest.resources).filter(Array.isArray).flat(),
  ])
    entry.createdAt = new Date(observed.getTime() - 60_000).toISOString();
  const digest = v1StagingBootstrapManifestDigest(runtimeManifest);
  const app = new App();
  const stack = new MissionControlV1StagingRuntimeStack(app, "Runtime", {
    env: { account: "661452835066", region: "us-east-1" },
    runId,
    bootstrapManifest: runtimeManifest,
    bootstrapManifestDigest: digest,
    webImageDigest: `sha256:${"1".repeat(64)}`,
    projectBrainImageDigest: `sha256:${"2".repeat(64)}`,
    stagingConfigurationDigest: "3".repeat(64),
    applicationCommit: "4".repeat(40),
    buildIdentityDigest: "5".repeat(64),
    projectBrainBuildIdentityDigest: "7".repeat(64),
    stagingCertificateDerSha256: "6".repeat(64),
  });
  const rendered = Template.fromStack(stack).toJSON();
  const taskDefinition = Object.values(rendered.Resources).find(({ Type }) => Type === "AWS::ECS::TaskDefinition");
  const web = taskDefinition.Properties.ContainerDefinitions.find(({ Name }) => Name === "web");
  assert.deepEqual(web.PortMappings, [{ ContainerPort: 3000, Protocol: "tcp" }]);
  const environment = Object.fromEntries(web.Environment.map(({ Name, Value }) => [Name, Value]));
  assert.equal(environment.HOSTNAME, "0.0.0.0");
  assert.equal(environment.PUBLIC_APP_URL, `https://${runtimeManifest.resources.loadBalancer.dnsName}`);
  assert.equal(environment.MISSION_CONTROL_V1_PRODUCTION_ROUTES_ENABLED, "true");
  const service = Object.values(rendered.Resources).find(({ Type }) => Type === "AWS::ECS::Service");
  assert.equal(service.Properties.DesiredCount, 1);
  assert.equal(service.Properties.NetworkConfiguration.AwsvpcConfiguration.AssignPublicIp, "ENABLED");
});

test("collector cannot sign directly and purpose-bound signer has no infrastructure query authority", () => {
  const app = new App();
  const bootstrap = new MissionControlV1StagingBootstrapStack(app, "BootstrapPolicy", {
    env: { account: "661452835066", region: "us-east-1" },
    runId,
    operatorRoleArn: `arn:aws:iam::661452835066:role/${prefix}-deployer`,
    operatorIpv4Cidr: "203.0.113.1/32",
    certificateArn: "arn:aws:acm:us-east-1:661452835066:certificate/00000000-0000-0000-0000-000000000000",
    signerFunctionArn,
    attestationKeyArn,
  });
  const bootstrapPolicies = Object.values(Template.fromStack(bootstrap).toJSON().Resources).filter(
    ({ Type }) => Type === "AWS::IAM::Policy",
  );
  const bootstrapTemplate = Template.fromStack(bootstrap).toJSON();
  const workloadRoles = Object.values(bootstrapTemplate.Resources).filter(
    ({ Type, Properties }) =>
      Type === "AWS::IAM::Role" &&
      ["task", "execution", "probe", "collector"].some((suffix) => String(Properties.RoleName).endsWith(`-${suffix}`)),
  );
  assert.equal(workloadRoles.length, 4);
  assert.ok(workloadRoles.every(({ Properties }) => Properties.PermissionsBoundary));
  assert.equal(Object.values(bootstrapTemplate.Resources).filter(({ Type }) => Type === "AWS::KMS::Key").length, 0);
  assert.ok(
    bootstrapPolicies.some(({ Properties }) =>
      Properties.PolicyDocument.Statement.some(
        ({ Effect, Action, Resource }) =>
          Effect === "Deny" && (Action === "kms:Sign" || Action?.includes?.("kms:Sign")) && Resource === "*",
      ),
    ),
  );
  const signerApp = new App();
  const signerManifest = structuredClone(manifest);
  const signerObserved = new Date();
  signerManifest.observedAt = signerObserved.toISOString();
  signerManifest.expiresAt = new Date(signerObserved.getTime() + 60 * 60_000).toISOString();
  for (const entry of [
    ...Object.values(signerManifest.resources).filter((item) => item && !Array.isArray(item)),
    ...Object.values(signerManifest.resources).filter(Array.isArray).flat(),
  ])
    entry.createdAt = new Date(signerObserved.getTime() - 60_000).toISOString();
  const signerManifestDigest = v1StagingBootstrapManifestDigest(signerManifest);
  const signerImagePolicy = (imageDigest) => ({
    imageDigest,
    bootstrapManifestDigest: signerManifestDigest,
    provenance: { sourceCommit: "4".repeat(40) },
  });
  const signer = new MissionControlV1StagingAuthorityStack(signerApp, "SignerPolicy", {
    env: { account: "661452835066", region: "us-east-1" },
    runId,
    signingEnabled: true,
    bootstrapManifest: signerManifest,
    bootstrapManifestDigest: signerManifestDigest,
    webImageDigest: `sha256:${"2".repeat(64)}`,
    projectBrainImageDigest: `sha256:${"3".repeat(64)}`,
    applicationCommit: "4".repeat(40),
    imagePolicies: [signerImagePolicy(`sha256:${"2".repeat(64)}`), signerImagePolicy(`sha256:${"3".repeat(64)}`)],
  });
  const signerPolicies = Object.values(Template.fromStack(signer).toJSON().Resources)
    .filter(({ Type }) => Type === "AWS::IAM::Policy")
    .flatMap(({ Properties }) => Properties.PolicyDocument.Statement);
  const actions = signerPolicies.flatMap(({ Action }) => (Array.isArray(Action) ? Action : [Action]));
  assert.deepEqual(
    actions.filter(
      (action) =>
        ![
          "kms:Sign",
          "s3:PutObject",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "ecr:DescribeImages",
          "rds:DescribeDBInstances",
          "ecs:DescribeServices",
          "ecs:DescribeTasks",
          "ecs:ListTasks",
          "ecs:DescribeTaskDefinition",
          "elasticloadbalancing:DescribeTargetHealth",
        ].includes(action),
    ),
    [],
  );
  const authorityTemplate = Template.fromStack(signer).toJSON();
  const authorityKeys = Object.values(authorityTemplate.Resources).filter(({ Type }) => Type === "AWS::KMS::Key");
  assert.equal(authorityKeys.length, 1);
  assert.ok(
    authorityKeys[0].Properties.KeyPolicy.Statement.some(
      ({ Sid, Effect, Action, Condition }) =>
        Sid === "DenySigningOutsideExactAuthoritySigner" &&
        Effect === "Deny" &&
        Action === "kms:Sign" &&
        Condition?.ArnNotEquals?.["aws:PrincipalArn"] === signerRoleArn,
    ),
  );
  const signerRole = Object.values(Template.fromStack(signer).toJSON().Resources).find(
    ({ Type }) => Type === "AWS::IAM::Role",
  );
  assert.ok(signerRole.Properties.PermissionsBoundary);
});

test("staging deployment control plane is run-bound and cannot mutate signer authority", () => {
  const app = new App();
  const stack = new MissionControlV1StagingDeploymentStack(app, "Deployment", {
    env: { account: "661452835066", region: "us-east-1" },
    runId,
    operatorRoleArn:
      "arn:aws:iam::661452835066:role/aws-reserved/sso.amazonaws.com/us-east-1/AWSReservedSSO_Test_0123456789abcdef",
    signerFunctionArn,
    signerRoleArn,
    attestationKeyArn,
  });
  const rendered = Template.fromStack(stack).toJSON();
  const serialized = JSON.stringify(rendered);
  assert.ok(!serialized.includes("AdministratorAccess"));
  assert.ok(!serialized.includes("mission-control-production"));
  assert.ok(!serialized.includes("app.missioncontrol.wallyweb.com"));
  assert.ok(!serialized.includes(`${prefix}-authority-signer-boundary`));
  assert.ok(
    Object.values(rendered.Resources)
      .filter(({ Type }) => Type === "AWS::Lambda::Function")
      .every(({ Properties }) => Properties.FunctionName !== `mcv1-${runId}-signer`),
  );
  assert.ok(!serialized.includes("AWS::KMS::Key"));
  const policies = Object.values(rendered.Resources)
    .filter(({ Type }) => Type === "AWS::IAM::Policy")
    .flatMap(({ Properties }) => Properties.PolicyDocument.Statement);
  const deployerRoleLogicalId = Object.entries(rendered.Resources).find(
    ([, { Type, Properties }]) => Type === "AWS::IAM::Role" && Properties.RoleName === `${prefix}-deployer`,
  )?.[0];
  assert.ok(deployerRoleLogicalId);
  const deployerPolicy = Object.values(rendered.Resources).find(
    ({ Type, Properties }) =>
      Type === "AWS::IAM::Policy" &&
      Properties.Roles?.some(({ Ref }) => Ref === deployerRoleLogicalId) &&
      Properties.PolicyDocument.Statement.some(
        ({ Effect, Action }) =>
          Effect === "Deny" && (Array.isArray(Action) ? Action : [Action]).includes("lambda:InvokeFunction"),
      ),
  );
  assert.ok(deployerPolicy);
  assert.ok(
    !deployerPolicy.Properties.PolicyDocument.Statement.some(
      ({ Effect, Action }) =>
        Effect === "Allow" && (Array.isArray(Action) ? Action : [Action]).includes("lambda:InvokeFunction"),
    ),
  );
  assert.ok(
    deployerPolicy.Properties.PolicyDocument.Statement.some(
      ({ Effect, Action, Resource }) =>
        Effect === "Allow" &&
        (Array.isArray(Action) ? Action : [Action]).includes("s3:ListBucketVersions") &&
        Resource === `arn:aws:s3:::mc-v1-stage-${runId}-661452835066`,
    ),
  );
  assert.ok(
    deployerPolicy.Properties.PolicyDocument.Statement.some(
      ({ Effect, Action, Resource }) =>
        Effect === "Allow" &&
        ["s3:DeleteObject", "s3:DeleteObjectVersion"].every((entry) =>
          (Array.isArray(Action) ? Action : [Action]).includes(entry),
        ) &&
        Resource === `arn:aws:s3:::mc-v1-stage-${runId}-661452835066/*`,
    ),
  );
  assert.ok(
    policies.some(
      ({ Effect, Action, Resource }) =>
        Effect === "Deny" &&
        (Action === "kms:Sign" || Action?.includes?.("kms:Sign")) &&
        (Array.isArray(Resource) ? Resource : [Resource]).includes(attestationKeyArn),
    ),
  );
  assert.ok(
    policies.some(
      ({ Effect, Action, Resource }) =>
        Effect === "Allow" &&
        (Array.isArray(Action) ? Action : [Action]).includes("elasticloadbalancing:DeleteListener") &&
        Resource === `arn:aws:elasticloadbalancing:us-east-1:661452835066:listener/app/mcv1-${runId}-alb/*/*`,
    ),
  );
  const cloudFormationResources = policies
    .filter(
      ({ Effect, Action }) =>
        Effect !== "Deny" &&
        (Array.isArray(Action) ? Action : [Action]).some((entry) => entry?.startsWith("cloudformation:")),
    )
    .flatMap(({ Resource }) => (Array.isArray(Resource) ? Resource : [Resource]));
  assert.ok(cloudFormationResources.length > 0);
  assert.ok(cloudFormationResources.every((entry) => String(entry).includes(`${prefix}-`)));
});

test("deployed signer code rejects arbitrary, stale, mismatched, and replayed envelopes", async () => {
  const used = new Set();
  class Command {
    constructor(input) {
      this.input = input;
    }
  }
  class KmsClient {
    async send() {
      return {
        Signature: Buffer.from("test-signature"),
        KeyId: "arn:aws:kms:us-east-1:661452835066:key/staging",
        SigningAlgorithm: "ED25519_SHA_512",
      };
    }
  }
  class S3Client {
    async send(command) {
      if (used.has(command.input.Key)) throw new Error("PreconditionFailed");
      used.add(command.input.Key);
      return {};
    }
  }
  const exports = {};
  const signerEnvironment = {
    SIGNING_ENABLED: "true",
    RUN_ID: runId,
    ACCOUNT_ID: "661452835066",
    AWS_REGION: "us-east-1",
    BOOTSTRAP_MANIFEST_DIGEST: "1".repeat(64),
    WEB_IMAGE_DIGEST: `sha256:${"2".repeat(64)}`,
    PROJECT_BRAIN_IMAGE_DIGEST: `sha256:${"3".repeat(64)}`,
    APPLICATION_COMMIT: "4".repeat(40),
    REPOSITORY_URI: `661452835066.dkr.ecr.us-east-1.amazonaws.com/${prefix}`,
    REPOSITORY_ARN: `arn:aws:ecr:us-east-1:661452835066:repository/${prefix}`,
    DATABASE_ARN: `arn:aws:rds:us-east-1:661452835066:db:${prefix}-postgres`,
    DATABASE_ID: `${prefix}-postgres`,
    DATABASE_ENDPOINT: `${prefix}-postgres.abc.us-east-1.rds.amazonaws.com`,
    CLUSTER_ARN: `arn:aws:ecs:us-east-1:661452835066:cluster/${prefix}-cluster`,
    EVIDENCE_BUCKET: "test",
    KEY_ARN: "arn:aws:kms:us-east-1:661452835066:key/staging",
    IMAGE_POLICY_DIGESTS_JSON: "[]",
    RUNTIME_IDENTITY_POLICY_DIGEST: "",
  };
  vm.runInNewContext(stagingSignerCode, {
    exports,
    Buffer,
    console: { log() {} },
    process: { env: signerEnvironment },
    require(name) {
      if (name === "crypto") return nodeCrypto;
      if (name === "@aws-sdk/client-kms") return { KMSClient: KmsClient, SignCommand: Command };
      if (name === "@aws-sdk/client-s3") return { S3Client, PutObjectCommand: Command };
      if (name === "@aws-sdk/client-ecr")
        return {
          ECRClient: class {
            async send(command) {
              return { imageDetails: [{ imageDigest: command.input.imageIds[0].imageDigest }] };
            }
          },
          DescribeImagesCommand: Command,
        };
      if (name === "@aws-sdk/client-rds") return { RDSClient: class {}, DescribeDBInstancesCommand: Command };
      if (name === "@aws-sdk/client-ecs")
        return {
          ECSClient: class {},
          ListTasksCommand: Command,
          DescribeTasksCommand: Command,
          DescribeServicesCommand: Command,
          DescribeTaskDefinitionCommand: Command,
        };
      if (name === "@aws-sdk/client-elastic-load-balancing-v2")
        return {
          ElasticLoadBalancingV2Client: class {},
          DescribeTargetHealthCommand: Command,
        };
      throw new Error(`Unexpected module ${name}`);
    },
  });
  const now = new Date();
  const digest = `sha256:${"2".repeat(64)}`;
  const evidence = {
    schemaVersion: "mission-control-image-provenance-receipt-v1",
    imageDigest: digest,
    imageReference: `661452835066.dkr.ecr.us-east-1.amazonaws.com/${prefix}@${digest}`,
    ociManifestDigest: digest,
    ociPlatformManifestDigest: digest,
    ociImageConfigurationDigest: `sha256:${"5".repeat(64)}`,
    bootstrapManifestDigest: "1".repeat(64),
    provenance: {
      schemaVersion: "mission-control-build-provenance-v2",
      sourceCommit: "4".repeat(40),
      sourceState: "clean",
      buildMode: "production",
    },
  };
  const request = {
    schemaVersion: "mission-control-v1-staging-attestation-request/1",
    kind: "image-provenance",
    runId,
    accountId: "661452835066",
    region: "us-east-1",
    bootstrapManifestDigest: "1".repeat(64),
    observedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    nonce: "00000000-0000-4000-8000-000000000001",
    sequence: 1,
    evidence,
  };
  signerEnvironment.IMAGE_POLICY_DIGESTS_JSON = JSON.stringify([
    nodeCrypto.createHash("sha256").update(canonicalJson(evidence)).digest("hex"),
  ]);
  const invoke = (value) => exports.handler({ canonicalEnvelope: canonicalJson(value) });
  await invoke(request);
  await assert.rejects(() => invoke(request), /PreconditionFailed/);
  await assert.rejects(
    () =>
      invoke({
        ...request,
        nonce: "00000000-0000-4000-8000-000000000002",
        evidence: { ...evidence, ociImageConfigurationDigest: `sha256:${"9".repeat(64)}` },
      }),
    /attestation_policy_rejected/,
  );
  await assert.rejects(
    () =>
      invoke({
        ...request,
        accountId: "000000000000",
        nonce: "00000000-0000-4000-8000-000000000003",
      }),
    /attestation_request_rejected/,
  );
  await assert.rejects(
    () =>
      invoke({
        ...request,
        observedAt: new Date(now.getTime() - 600_000).toISOString(),
        nonce: "00000000-0000-4000-8000-000000000004",
      }),
    /attestation_stale/,
  );
  await assert.rejects(
    () =>
      invoke({
        ...request,
        kind: "arbitrary",
        nonce: "00000000-0000-4000-8000-000000000005",
      }),
    /attestation_policy_rejected/,
  );
});
