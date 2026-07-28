import assert from "node:assert/strict";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import {
  buildIdentityDigest,
  validateBuildProvenance,
  validateEcsControlPlaneIdentity,
} from "../application/v1-production-runtime-identity.ts";
import { MissionControlV1EcsStack } from "../infra/mission-control-v1-ecs-stack.ts";
import { validateV1RollbackTarget } from "../application/v1-ecs-rollback-readiness.ts";

const digest = (character) => character.repeat(64);
const now = Date.parse("2026-07-27T18:00:00.000Z");
const evidence = {
  observedAt: "2026-07-27T17:59:30.000Z",
  expiresAt: "2026-07-27T18:04:30.000Z",
  awsAccountId: "661452835066",
  region: "us-east-1",
  clusterArn: "arn:aws:ecs:us-east-1:661452835066:cluster/mission-control-v1-production",
  serviceArn: "arn:aws:ecs:us-east-1:661452835066:service/mission-control-v1-production/mission-control-v1",
  deploymentId: "ecs-svc/123",
  taskDefinitionArn: "arn:aws:ecs:us-east-1:661452835066:task-definition/mission-control-v1-production:7",
  taskArn: "arn:aws:ecs:us-east-1:661452835066:task/mission-control-v1-production/00000000000000000000000000000001",
  desiredCount: 1,
  runningCount: 1,
  pendingCount: 0,
  deploymentCount: 1,
  primaryRolloutState: "COMPLETED",
  taskLastStatus: "RUNNING",
  taskHealthStatus: "HEALTHY",
  targetHealth: "healthy",
  runningTaskArns: [
    "arn:aws:ecs:us-east-1:661452835066:task/mission-control-v1-production/00000000000000000000000000000001",
  ],
  ecrRepositoryArn: "arn:aws:ecr:us-east-1:661452835066:repository/mission-control",
  imageDigest: `sha256:${digest("a")}`,
  containers: {
    web: { imageDigest: `sha256:${digest("a")}`, command: [], essential: true },
    "generic-worker": {
      imageDigest: `sha256:${digest("a")}`,
      command: ["node", "node_modules/tsx/dist/cli.mjs", "scripts/worker.ts"],
      essential: true,
    },
    "project-brain-worker": {
      imageDigest: `sha256:${digest("b")}`,
      command: ["node", "node_modules/tsx/dist/cli.mjs", "scripts/project-brain-worker.ts"],
      essential: true,
    },
    "remote-agent-worker": {
      imageDigest: `sha256:${digest("a")}`,
      command: ["node", "node_modules/tsx/dist/cli.mjs", "scripts/remote-agent-worker.ts"],
      essential: true,
    },
  },
  taskRoleArn: "arn:aws:iam::661452835066:role/mission-control-v1-task",
  executionRoleArn: "arn:aws:iam::661452835066:role/mission-control-v1-execution",
  configurationDigest: digest("b"),
  applicationCommit: "c".repeat(40),
  buildIdentityDigest: digest("d"),
  bootstrapManifestDigest: digest("f"),
};
const expected = {
  ...evidence,
  maximumEvidenceAgeMs: 5 * 60_000,
};
delete expected.observedAt;
delete expected.expiresAt;
delete expected.runningCount;
delete expected.runningTaskArns;

test("build provenance is strict and digest-stable", () => {
  const provenance = {
    schemaVersion: "mission-control-build-provenance-v2",
    sourceCommit: "c".repeat(40),
    sourceTreeObject: "f".repeat(40),
    sourceArchiveDigest: digest("0"),
    sourceInputManifestDigest: digest("9"),
    sourceState: "clean",
    buildMode: "production",
    buildTimestamp: "2026-07-27T17:00:00.000Z",
    builderIdentity: "staging-release-builder",
    repositoryIdentity: "wallyweb/mission-control",
    buildWorkflowIdentity: "reviewed-staging-build-v1",
    lockfileDigest: digest("1"),
    dockerfileDigests: { web: digest("3"), projectBrain: digest("4") },
    baseImageDigests: { webNode: `sha256:${digest("a")}`, projectBrainNode: `sha256:${digest("b")}` },
    buildScriptDigests: { generateProvenance: digest("5"), verifySourceInput: digest("6") },
    configurationTemplateDigests: { ecs: digest("7"), bootstrap: digest("8") },
    applicationBundleDigest: digest("2"),
    productionContractVersion: "mission-control-production-rollout-v1",
    databaseCompatibility: { minimum: "0028", maximum: "0030" },
  };
  validateBuildProvenance(provenance);
  assert.match(buildIdentityDigest(provenance), /^[a-f0-9]{64}$/);
  assert.throws(() => validateBuildProvenance({ ...provenance, sourceState: "dirty-ish" }));
  assert.throws(() => validateBuildProvenance({ ...provenance, sourceState: "dirty" }));
});

test("ECS identity accepts exact fresh single-task control-plane evidence", () => {
  validateEcsControlPlaneIdentity(evidence, expected, now);
});

for (const [name, mutate] of [
  ["wrong image digest", (value) => (value.imageDigest = `sha256:${digest("e")}`)],
  ["wrong task definition", (value) => (value.taskDefinitionArn += ":wrong")],
  ["wrong service", (value) => (value.serviceArn += "-wrong")],
  ["wrong cluster", (value) => (value.clusterArn += "-wrong")],
  ["stale evidence", (value) => (value.observedAt = "2026-07-27T17:00:00.000Z")],
  ["configuration drift", (value) => (value.configurationDigest = digest("e"))],
  ["application commit drift", (value) => (value.applicationCommit = "e".repeat(40))],
  ["runtime environment contradiction", (value) => (value.buildIdentityDigest = digest("e"))],
  [
    "more than one task",
    (value) => {
      value.runningCount = 2;
      value.runningTaskArns.push(`${value.taskArn}-second`);
    },
  ],
  ["pending replacement", (value) => (value.pendingCount = 1)],
  ["incomplete deployment", (value) => (value.primaryRolloutState = "IN_PROGRESS")],
  ["unhealthy target", (value) => (value.targetHealth = "unhealthy")],
  [
    "substituted Project Brain worker",
    (value) => {
      value.containers["project-brain-worker"].imageDigest = `sha256:${digest("f")}`;
    },
  ],
  [
    "extra executable container",
    (value) => {
      value.containers.shell = { imageDigest: `sha256:${digest("a")}`, command: ["sh"], essential: true };
    },
  ],
]) {
  test(`ECS identity fails closed for ${name}`, () => {
    const changed = structuredClone(evidence);
    mutate(changed);
    assert.throws(() => validateEcsControlPlaneIdentity(changed, expected, now), /identity|evidence/);
  });
}

test("v1 ECS template is one digest-pinned service with four fixed containers", () => {
  const app = new cdk.App();
  const stack = new MissionControlV1EcsStack(app, "Acceptance", {
    env: { account: "661452835066", region: "us-east-1" },
    vpcId: "vpc-12345678",
    availabilityZones: ["us-east-1a", "us-east-1b"],
    publicSubnetIds: ["subnet-11111111", "subnet-22222222"],
    webImageDigest: `sha256:${digest("a")}`,
    projectBrainImageDigest: `sha256:${digest("b")}`,
    databaseSecretArn: "arn:aws:secretsmanager:us-east-1:661452835066:secret:mission-control/staging/database-AbCdEf",
    runtimeSecretArn: "arn:aws:secretsmanager:us-east-1:661452835066:secret:mission-control/staging/runtime-AbCdEf",
    artifactBucketName: "mission-control-staging-artifacts-661452835066",
    certificateArn: "arn:aws:acm:us-east-1:661452835066:certificate/00000000-0000-4000-8000-000000000001",
    productionConfigurationDigest: digest("c"),
    applicationCommit: "d".repeat(40),
    buildIdentityDigest: digest("e"),
  });
  const template = Template.fromStack(stack);
  template.resourceCountIs("AWS::ECS::Service", 1);
  template.hasResourceProperties("AWS::ECS::Service", { DesiredCount: 1 });
  const serialized = JSON.stringify(template.toJSON());
  for (const name of ["web", "generic-worker", "project-brain-worker", "remote-agent-worker"])
    assert.match(serialized, new RegExp(`"Name":"${name}"`));
  assert.equal(
    (serialized.match(/"Name":"(?:web|generic-worker|project-brain-worker|remote-agent-worker)"/g) ?? []).length,
    4,
  );
  assert.match(serialized, new RegExp(`sha256:${digest("a")}`));
  assert.match(serialized, new RegExp(`sha256:${digest("b")}`));
  assert.doesNotMatch(serialized, /":latest"/);
});

test("EC2 rollback target must be fresh, healthy, exact, and 0030-compatible", () => {
  const rollback = {
    schemaVersion: "mission-control-v1-rollback-target-evidence-v1",
    observedAt: "2026-07-27T17:59:30.000Z",
    expiresAt: "2026-07-27T18:04:30.000Z",
    ec2InstanceId: "i-0123456789abcdef0",
    imageDigest: `sha256:${digest("9")}`,
    applicationCommit: "6a630b9d7be87c5cc121477b8a639ffc531cd743",
    endpoint: "https://rollback.invalid",
    healthStatus: "healthy",
    readinessStatus: "ready",
    databaseCompatibility: { minimum: "0026", maximum: "0030" },
    preCutoverRoutingChecksum: digest("8"),
    configurationChecksum: digest("7"),
  };
  assert.match(validateV1RollbackTarget(rollback, structuredClone(rollback), now), /^[a-f0-9]{64}$/);
  assert.throws(() => validateV1RollbackTarget({ ...rollback, readinessStatus: "not-ready" }, rollback, now));
  assert.throws(() =>
    validateV1RollbackTarget(
      { ...rollback, databaseCompatibility: { minimum: "0026", maximum: "0029" } },
      rollback,
      now,
    ),
  );
});
