import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "./v1-production-runtime-identity";
import type { V1OperatorBinding, V1OperatorOperation } from "./v1-macos-operator-journal";

export type V1OperatorGrant = {
  schemaVersion: "mission-agent-v1-operator-grant-v1";
  binding: V1OperatorBinding;
  credentialId: string;
  approvedExecutableChecksum: string;
  allowedOperations: V1OperatorOperation[];
  missionControlUrl: string;
  issuedAt: string;
  authenticationTag: string;
};

function payload(grant: V1OperatorGrant): Omit<V1OperatorGrant, "authenticationTag"> {
  const { authenticationTag: _tag, ...value } = grant;
  return value;
}

function authenticate(value: unknown, key: string): string {
  return createHmac("sha256", key).update(canonicalJson(value)).digest("hex");
}

export function createV1OperatorGrant(value: Omit<V1OperatorGrant, "authenticationTag">, key: string): V1OperatorGrant {
  return { ...value, authenticationTag: authenticate(value, key) };
}

export function verifyV1OperatorGrant(grant: V1OperatorGrant, key: string): void {
  const expected = Uint8Array.from(Buffer.from(authenticate(payload(grant), key), "hex"));
  const supplied = Uint8Array.from(Buffer.from(grant.authenticationTag, "hex"));
  if (
    grant.schemaVersion !== "mission-agent-v1-operator-grant-v1" ||
    !/^[a-f0-9]{64}$/.test(grant.approvedExecutableChecksum) ||
    !grant.missionControlUrl.startsWith("https://") ||
    !Number.isFinite(Date.parse(grant.issuedAt)) ||
    new Set(grant.allowedOperations).size !== grant.allowedOperations.length ||
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    throw new Error("V1 operator grant is malformed or unauthenticated.");
}
