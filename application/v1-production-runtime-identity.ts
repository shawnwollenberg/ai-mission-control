import { createHash } from "node:crypto";

export const V1_PRODUCTION_CONTRACT_VERSION = "mission-control-production-rollout-v1";
export const V1_DATABASE_COMPATIBILITY = { minimum: "0028", maximum: "0030" } as const;

const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;

export type V1BuildProvenance = {
  schemaVersion: "mission-control-build-provenance-v2";
  sourceCommit: string;
  sourceTreeObject: string;
  sourceArchiveDigest: string;
  sourceInputManifestDigest: string;
  sourceState: "clean" | "dirty";
  buildMode: "production" | "disposable";
  buildTimestamp: string;
  builderIdentity: string;
  repositoryIdentity: string;
  buildWorkflowIdentity: string;
  lockfileDigest: string;
  dockerfileDigests: { web: string; projectBrain: string };
  baseImageDigests: { webNode: string; projectBrainNode: string };
  buildScriptDigests: { generateProvenance: string; verifySourceInput: string };
  configurationTemplateDigests: { ecs: string; bootstrap: string };
  applicationBundleDigest: string;
  productionContractVersion: typeof V1_PRODUCTION_CONTRACT_VERSION;
  databaseCompatibility: typeof V1_DATABASE_COMPATIBILITY;
};

export type V1EcsControlPlaneEvidence = {
  observedAt: string;
  expiresAt: string;
  awsAccountId: string;
  region: string;
  clusterArn: string;
  serviceArn: string;
  deploymentId: string;
  taskDefinitionArn: string;
  taskArn: string;
  desiredCount: number;
  runningCount: number;
  pendingCount: number;
  deploymentCount: number;
  primaryRolloutState: "COMPLETED";
  taskLastStatus: "RUNNING";
  taskHealthStatus: "HEALTHY";
  targetHealth: "healthy";
  runningTaskArns: string[];
  ecrRepositoryArn: string;
  imageDigest: string;
  containers: Record<string, { imageDigest: string; command: string[]; essential: boolean }>;
  taskRoleArn: string;
  executionRoleArn: string;
  configurationDigest: string;
  applicationCommit: string;
  buildIdentityDigest: string;
  bootstrapManifestDigest: string;
};

export type V1ExpectedRuntimeIdentity = Omit<
  V1EcsControlPlaneEvidence,
  "observedAt" | "expiresAt" | "runningCount" | "runningTaskArns"
> & {
  maximumEvidenceAgeMs: number;
};

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function validateBuildProvenance(value: V1BuildProvenance): void {
  if (
    value.schemaVersion !== "mission-control-build-provenance-v2" ||
    !COMMIT.test(value.sourceCommit) ||
    !COMMIT.test(value.sourceTreeObject) ||
    !SHA256.test(value.sourceArchiveDigest) ||
    !SHA256.test(value.sourceInputManifestDigest) ||
    !["clean", "dirty"].includes(value.sourceState) ||
    !["production", "disposable"].includes(value.buildMode) ||
    (value.buildMode === "production" && value.sourceState !== "clean") ||
    !Number.isFinite(Date.parse(value.buildTimestamp)) ||
    !value.builderIdentity ||
    !value.repositoryIdentity ||
    !value.buildWorkflowIdentity ||
    !SHA256.test(value.lockfileDigest) ||
    Object.values(value.dockerfileDigests).some((digest) => !SHA256.test(digest)) ||
    Object.values(value.baseImageDigests).some((digest) => !IMAGE_DIGEST.test(digest)) ||
    Object.values(value.buildScriptDigests).some((digest) => !SHA256.test(digest)) ||
    Object.values(value.configurationTemplateDigests).some((digest) => !SHA256.test(digest)) ||
    !SHA256.test(value.applicationBundleDigest) ||
    value.productionContractVersion !== V1_PRODUCTION_CONTRACT_VERSION ||
    value.databaseCompatibility.minimum !== V1_DATABASE_COMPATIBILITY.minimum ||
    value.databaseCompatibility.maximum !== V1_DATABASE_COMPATIBILITY.maximum
  )
    throw new Error("Mission Control build provenance is malformed or incompatible.");
}

export function validateEcsControlPlaneIdentity(
  evidence: V1EcsControlPlaneEvidence,
  expected: V1ExpectedRuntimeIdentity,
  now = Date.now(),
): void {
  const observedAt = Date.parse(evidence.observedAt);
  const expiresAt = Date.parse(evidence.expiresAt);
  if (
    !Number.isFinite(observedAt) ||
    !Number.isFinite(expiresAt) ||
    observedAt > now + 60_000 ||
    now - observedAt > expected.maximumEvidenceAgeMs ||
    expiresAt <= now ||
    evidence.desiredCount !== 1 ||
    evidence.runningCount !== 1 ||
    evidence.pendingCount !== 0 ||
    evidence.deploymentCount !== 1 ||
    evidence.primaryRolloutState !== "COMPLETED" ||
    evidence.taskLastStatus !== "RUNNING" ||
    evidence.taskHealthStatus !== "HEALTHY" ||
    evidence.targetHealth !== "healthy" ||
    evidence.runningTaskArns.length !== 1 ||
    evidence.runningTaskArns[0] !== evidence.taskArn ||
    !IMAGE_DIGEST.test(evidence.imageDigest) ||
    Object.keys(evidence.containers).sort().join(",") !==
      ["generic-worker", "project-brain-worker", "remote-agent-worker", "web"].join(",") ||
    Object.values(evidence.containers).some(
      ({ imageDigest, essential }) => !IMAGE_DIGEST.test(imageDigest) || essential !== true,
    ) ||
    canonicalJson(evidence.containers) !== canonicalJson(expected.containers) ||
    !SHA256.test(evidence.configurationDigest) ||
    !SHA256.test(evidence.buildIdentityDigest) ||
    !SHA256.test(evidence.bootstrapManifestDigest) ||
    !COMMIT.test(evidence.applicationCommit)
  )
    throw new Error("Mission Control ECS control-plane evidence is stale, malformed, or not single-task.");

  for (const field of [
    "awsAccountId",
    "region",
    "clusterArn",
    "serviceArn",
    "deploymentId",
    "taskDefinitionArn",
    "taskArn",
    "desiredCount",
    "pendingCount",
    "deploymentCount",
    "primaryRolloutState",
    "taskLastStatus",
    "taskHealthStatus",
    "targetHealth",
    "ecrRepositoryArn",
    "imageDigest",
    "taskRoleArn",
    "executionRoleArn",
    "configurationDigest",
    "applicationCommit",
    "buildIdentityDigest",
    "bootstrapManifestDigest",
  ] as const)
    if (evidence[field] !== expected[field])
      throw new Error(`Mission Control ECS control-plane identity mismatch: ${field}.`);
}

export function buildIdentityDigest(provenance: V1BuildProvenance): string {
  validateBuildProvenance(provenance);
  return sha256(canonicalJson(provenance));
}
