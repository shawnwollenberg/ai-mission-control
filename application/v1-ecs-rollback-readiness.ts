import { canonicalJson, sha256 } from "./v1-production-runtime-identity";

const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const CHECKSUM = /^[a-f0-9]{64}$/;

export type V1RollbackTargetEvidence = {
  schemaVersion: "mission-control-v1-rollback-target-evidence-v1";
  observedAt: string;
  expiresAt: string;
  ec2InstanceId: string;
  imageDigest: string;
  applicationCommit: string;
  endpoint: string;
  healthStatus: "healthy";
  readinessStatus: "ready";
  databaseCompatibility: { minimum: string; maximum: string };
  preCutoverRoutingChecksum: string;
  configurationChecksum: string;
};

export function validateV1RollbackTarget(
  evidence: V1RollbackTargetEvidence,
  expected: V1RollbackTargetEvidence,
  now = Date.now(),
): string {
  const observed = Date.parse(evidence.observedAt);
  const expires = Date.parse(evidence.expiresAt);
  if (
    evidence.schemaVersion !== "mission-control-v1-rollback-target-evidence-v1" ||
    !Number.isFinite(observed) ||
    !Number.isFinite(expires) ||
    now - observed > 5 * 60_000 ||
    observed > now + 60_000 ||
    expires <= now ||
    !/^i-[a-f0-9]{8,17}$/.test(evidence.ec2InstanceId) ||
    !IMAGE_DIGEST.test(evidence.imageDigest) ||
    !COMMIT.test(evidence.applicationCommit) ||
    !evidence.endpoint.startsWith("https://") ||
    !CHECKSUM.test(evidence.preCutoverRoutingChecksum) ||
    !CHECKSUM.test(evidence.configurationChecksum) ||
    evidence.healthStatus !== "healthy" ||
    evidence.readinessStatus !== "ready" ||
    evidence.databaseCompatibility.maximum < "0030" ||
    canonicalJson(evidence) !== canonicalJson(expected)
  )
    throw new Error("EC2 rollback target is stale, unhealthy, incompatible, or contradictory.");
  return sha256(canonicalJson(evidence));
}
