import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  NAMED_CANARY_ID,
  REPLACEMENT_BOOTSTRAP_PROTOCOL,
  authorizationChecksum,
  validateReplacementAuthorization,
  type ReplacementAuthorization,
} from "./replacement-bootstrap";
import { canonicalJson } from "./release-authority";

export const REPLACEMENT_PACKAGE_VERSION = "replacement-authorization-package-v1" as const;
export const REPLACEMENT_CREDENTIAL_PROTOCOL = "replacement-bootstrap-v1" as const;
export const MISSION_CONTROL_INSTANCE_ID = "mission-control-disposable-replacement-bootstrap-v1" as const;
export const REPLACEMENT_CREDENTIAL_SERVICE = "com.wallyweb.mission-agent.replacement-bootstrap" as const;
export const REPLACEMENT_CLAIM_PATH = "/api/mission-agent/replacement-bootstrap/claim" as const;
export const REPLACEMENT_INTENT_PATH = "/api/mission-agent/replacement-bootstrap/intent" as const;
export const REPLACEMENT_RECEIPT_PATH = "/api/mission-agent/replacement-bootstrap/receipt" as const;
export const REPLACEMENT_DECISION_PATH = "/api/mission-agent/replacement-bootstrap/decision" as const;
export const REPLACEMENT_STATUS_PATH = "/api/mission-agent/replacement-bootstrap/status" as const;
export const REPLACEMENT_FAILURE_PATH = "/api/mission-agent/replacement-bootstrap/failure" as const;

const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const NONCE = /^[A-Za-z0-9_-]{32,128}$/;
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export type ReplacementApprovalSnapshot = {
  approvalId: string;
  status: "granted";
  decidedBy: string;
  actionHash: string;
  decidedAt: string;
  expiresAt: string;
};

export type ReplacementAuthorizationPackageUnsigned = {
  packageVersion: typeof REPLACEMENT_PACKAGE_VERSION;
  protocolVersion: typeof REPLACEMENT_BOOTSTRAP_PROTOCOL;
  credentialProtocol: typeof REPLACEMENT_CREDENTIAL_PROTOCOL;
  credentialId: string;
  missionControlInstanceIdentity: typeof MISSION_CONTROL_INSTANCE_ID;
  claimPath: typeof REPLACEMENT_CLAIM_PATH;
  intentPath: typeof REPLACEMENT_INTENT_PATH;
  receiptPath: typeof REPLACEMENT_RECEIPT_PATH;
  decisionPath: typeof REPLACEMENT_DECISION_PATH;
  statusPath: typeof REPLACEMENT_STATUS_PATH;
  failurePath: typeof REPLACEMENT_FAILURE_PATH;
  executionId: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  maximumUseCount: 1;
  authorization: ReplacementAuthorization;
  approval: ReplacementApprovalSnapshot;
  authorizationFingerprint: string;
  evidenceInstructions: {
    mode: "authenticated-receipt-api";
    localDirectory: string;
    receiptSequenceStartsAt: 1;
  };
};

export type ReplacementAuthorizationPackage = ReplacementAuthorizationPackageUnsigned & {
  packageChecksum: string;
  authentication: {
    algorithm: "hmac-sha256";
    credentialId: string;
    signature: string;
  };
};

const unsignedKeys = [
  "packageVersion",
  "protocolVersion",
  "credentialProtocol",
  "credentialId",
  "missionControlInstanceIdentity",
  "claimPath",
  "intentPath",
  "receiptPath",
  "decisionPath",
  "statusPath",
  "failurePath",
  "executionId",
  "nonce",
  "issuedAt",
  "expiresAt",
  "maximumUseCount",
  "authorization",
  "approval",
  "authorizationFingerprint",
  "evidenceInstructions",
] as const;

function exactKeys(value: object, keys: readonly string[], name: string): void {
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort()))
    throw new Error(`${name} contains missing or unknown fields.`);
}

export function packageSigningBytes(value: ReplacementAuthorizationPackageUnsigned): string {
  return canonicalJson(value);
}

export function createReplacementAuthorizationPackage(input: {
  unsigned: ReplacementAuthorizationPackageUnsigned;
  credentialSigningKey: string;
}): ReplacementAuthorizationPackage {
  validateReplacementAuthorization(input.unsigned.authorization, { now: new Date(input.unsigned.issuedAt) });
  validateUnsigned(input.unsigned);
  if (!SHA256.test(input.credentialSigningKey)) throw new Error("Replacement credential signing key is invalid.");
  const bytes = packageSigningBytes(input.unsigned);
  const packageChecksum = sha256(bytes);
  return {
    ...input.unsigned,
    packageChecksum,
    authentication: {
      algorithm: "hmac-sha256",
      credentialId: input.unsigned.credentialId,
      signature: createHmac("sha256", input.credentialSigningKey).update(bytes).digest("hex"),
    },
  };
}

function validateUnsigned(value: ReplacementAuthorizationPackageUnsigned): void {
  exactKeys(value, unsignedKeys, "Authorization package");
  exactKeys(
    value.approval,
    ["approvalId", "status", "decidedBy", "actionHash", "decidedAt", "expiresAt"],
    "Approval snapshot",
  );
  exactKeys(value.evidenceInstructions, ["mode", "localDirectory", "receiptSequenceStartsAt"], "Evidence instructions");
  const fingerprint = authorizationChecksum(value.authorization);
  if (
    value.packageVersion !== REPLACEMENT_PACKAGE_VERSION ||
    value.protocolVersion !== REPLACEMENT_BOOTSTRAP_PROTOCOL ||
    value.credentialProtocol !== REPLACEMENT_CREDENTIAL_PROTOCOL ||
    !UUID.test(value.credentialId) ||
    value.missionControlInstanceIdentity !== MISSION_CONTROL_INSTANCE_ID ||
    value.claimPath !== REPLACEMENT_CLAIM_PATH ||
    value.intentPath !== REPLACEMENT_INTENT_PATH ||
    value.receiptPath !== REPLACEMENT_RECEIPT_PATH ||
    value.decisionPath !== REPLACEMENT_DECISION_PATH ||
    value.statusPath !== REPLACEMENT_STATUS_PATH ||
    value.failurePath !== REPLACEMENT_FAILURE_PATH ||
    !UUID.test(value.executionId) ||
    !NONCE.test(value.nonce) ||
    value.maximumUseCount !== 1 ||
    value.authorization.agentId !== NAMED_CANARY_ID ||
    value.authorizationFingerprint !== fingerprint ||
    value.approval.approvalId !== value.authorization.approvalId ||
    value.approval.status !== "granted" ||
    value.approval.decidedBy !== value.authorization.approvedBy ||
    value.approval.actionHash !== fingerprint ||
    value.approval.expiresAt !== value.authorization.expiresAt ||
    value.evidenceInstructions.mode !== "authenticated-receipt-api" ||
    value.evidenceInstructions.localDirectory !== value.authorization.evidenceDestination ||
    value.evidenceInstructions.receiptSequenceStartsAt !== 1
  )
    throw new Error("Replacement authorization package binding is invalid.");
  for (const timestamp of [value.issuedAt, value.expiresAt, value.approval.decidedAt, value.approval.expiresAt])
    if (new Date(timestamp).toISOString() !== timestamp)
      throw new Error("Replacement authorization package timestamp is malformed.");
  if (
    value.issuedAt !== value.authorization.approvedAt ||
    value.expiresAt !== value.authorization.expiresAt ||
    Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)
  )
    throw new Error("Replacement authorization package time binding is invalid.");
}

export function verifyReplacementAuthorizationPackage(input: {
  value: unknown;
  credentialSigningKey: string;
  now?: Date;
  allowExpiredRecovery?: boolean;
}): ReplacementAuthorizationPackage {
  if (!input.value || typeof input.value !== "object" || Array.isArray(input.value))
    throw new Error("Replacement authorization package must be an object.");
  const value = input.value as ReplacementAuthorizationPackage;
  exactKeys(value, [...unsignedKeys, "packageChecksum", "authentication"], "Signed authorization package");
  exactKeys(value.authentication ?? {}, ["algorithm", "credentialId", "signature"], "Package authentication");
  const { packageChecksum, authentication, ...unsigned } = value;
  validateUnsigned(unsigned);
  const now = input.now ?? new Date();
  validateReplacementAuthorization(unsigned.authorization, {
    now: input.allowExpiredRecovery ? new Date(unsigned.authorization.approvedAt) : now,
  });
  if (
    authentication.algorithm !== "hmac-sha256" ||
    authentication.credentialId !== unsigned.credentialId ||
    !SHA256.test(authentication.signature) ||
    !SHA256.test(packageChecksum) ||
    !SHA256.test(input.credentialSigningKey) ||
    (!input.allowExpiredRecovery && Date.parse(unsigned.expiresAt) <= now.getTime())
  )
    throw new Error("Replacement package authentication metadata or expiry is invalid.");
  const bytes = packageSigningBytes(unsigned);
  const expectedChecksum = sha256(bytes);
  const expectedSignature = createHmac("sha256", input.credentialSigningKey).update(bytes).digest("hex");
  if (
    !timingSafeEqual(
      Uint8Array.from(Buffer.from(packageChecksum, "hex")),
      Uint8Array.from(Buffer.from(expectedChecksum, "hex")),
    ) ||
    !timingSafeEqual(
      Uint8Array.from(Buffer.from(authentication.signature, "hex")),
      Uint8Array.from(Buffer.from(expectedSignature, "hex")),
    )
  )
    throw new Error("Replacement authorization package checksum or authentication failed.");
  return value;
}
