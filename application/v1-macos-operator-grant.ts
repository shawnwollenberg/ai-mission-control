import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "./v1-production-runtime-identity";
import type { V1OperatorBinding, V1OperatorOperation } from "./v1-macos-operator-journal";

export type V1OperatorGrant = {
  schemaVersion: "mission-agent-v1-operator-grant-v1";
  grantId: string;
  grantKind: "forward" | "rollback" | "recovery";
  binding: V1OperatorBinding;
  credentialId: string;
  operationId: string;
  providerMutationId: string;
  sequence: number;
  lifecycleSequence: number;
  hostFingerprint: string;
  operatorArtifactSha256: string;
  operatorProtocolVersion: string;
  configurationVersion: number;
  originatingForwardDeploymentId: string;
  currentControllerDeploymentId: string;
  currentControllerFencingGeneration: number;
  rollbackObligationId: string;
  approvedExecutableChecksum: string;
  allowedOperation: V1OperatorOperation;
  missionControlUrl: string;
  issuedAt: string;
  expiresAt: string;
  authenticationTag: string;
};

function payload(grant: V1OperatorGrant): Omit<V1OperatorGrant, "authenticationTag"> {
  const value = { ...grant };
  delete (value as Partial<V1OperatorGrant>).authenticationTag;
  return value;
}

function authenticate(value: unknown, key: string): string {
  return createHmac("sha256", key).update(canonicalJson(value)).digest("hex");
}

export function createV1OperatorGrant(value: Omit<V1OperatorGrant, "authenticationTag">, key: string): V1OperatorGrant {
  return { ...value, authenticationTag: authenticate(value, key) };
}

export function verifyV1OperatorGrant(
  grant: V1OperatorGrant,
  key: string,
  now = new Date(),
  options: { allowExpiredReceiptRecovery?: boolean } = {},
): void {
  const expected = Uint8Array.from(Buffer.from(authenticate(payload(grant), key), "hex"));
  const supplied = Uint8Array.from(Buffer.from(grant.authenticationTag, "hex"));
  if (
    grant.schemaVersion !== "mission-agent-v1-operator-grant-v1" ||
    !/^[a-f0-9-]{36}$/.test(grant.grantId) ||
    !["forward", "rollback", "recovery"].includes(grant.grantKind) ||
    !/^[a-f0-9-]{36}$/.test(grant.operationId) ||
    !/^[a-f0-9-]{36}$/.test(grant.providerMutationId) ||
    grant.sequence < 1 ||
    grant.lifecycleSequence < 1 ||
    !/^ed25519-spki-sha256:[a-f0-9]{64}$/.test(grant.hostFingerprint) ||
    !/^[a-f0-9]{64}$/.test(grant.operatorArtifactSha256) ||
    !grant.operatorProtocolVersion ||
    grant.configurationVersion < 1 ||
    !grant.originatingForwardDeploymentId ||
    !grant.currentControllerDeploymentId ||
    grant.currentControllerFencingGeneration < 1 ||
    grant.rollbackObligationId !== grant.binding.rollbackObligationId ||
    grant.providerMutationId.length === 0 ||
    !/^[a-f0-9]{64}$/.test(grant.approvedExecutableChecksum) ||
    grant.operatorArtifactSha256 !== grant.approvedExecutableChecksum ||
    !grant.missionControlUrl.startsWith("https://") ||
    !Number.isFinite(Date.parse(grant.issuedAt)) ||
    !Number.isFinite(Date.parse(grant.expiresAt)) ||
    Date.parse(grant.expiresAt) <= Date.parse(grant.issuedAt) ||
    (!options.allowExpiredReceiptRecovery && Date.parse(grant.expiresAt) <= now.getTime()) ||
    Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt) > 15 * 60_000 ||
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    throw new Error("V1 operator grant is malformed or unauthenticated.");
}
