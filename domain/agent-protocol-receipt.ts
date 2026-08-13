import { createHash } from "node:crypto";
import { canonicalHash } from "@/lib/canonical-json";
import { stableUuid } from "@/lib/stable-id";
import { ValidationFailedError } from "@/lib/application-errors";
import { missionControlRuntimeMode, runtimeTrustReceiptBinding } from "@/lib/runtime-trust";

type CredentialBinding = { workspace_id: string; agent_id: string; credential_id: string };
export type LeaseAuthorizationKind = "execution_assignment" | "project_brain_assignment";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const exactKeys = (value: Record<string, unknown>, allowed: readonly string[], label: string) => {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new ValidationFailedError(`${label} contains unknown fields: ${unknown.join(", ")}`);
};

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ValidationFailedError(`${label} must be an object`);
  return value as Record<string, unknown>;
};

function assertNoSecretFieldNames(value: unknown, path = "receipt") {
  if (Array.isArray(value))
    return value.forEach((entry, index) => assertNoSecretFieldNames(entry, `${path}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const safeDerivedField = ["tokenfingerprint", "fencingtoken", "responsechecksum", "authorization"].includes(
      normalized,
    );
    if (
      !safeDerivedField &&
      (normalized === "token" ||
        normalized.endsWith("token") ||
        normalized.includes("password") ||
        normalized.includes("privatekey") ||
        normalized.endsWith("secret") ||
        normalized === "authorization" ||
        normalized === "cookie")
    )
      throw new ValidationFailedError(`${path}.${key} is a forbidden durable secret field`);
    assertNoSecretFieldNames(nested, `${path}.${key}`);
  }
}

export function processingProtocolReceipt(messageId: string) {
  const runtimeTrust =
    missionControlRuntimeMode() === "disposable_acceptance" ? runtimeTrustReceiptBinding() : undefined;
  const receipt = {
    schemaVersion: "agent-protocol-receipt/2",
    status: "processing",
    protocolVersion: "1.0",
    messageId,
    ...(runtimeTrust ? { runtimeTrust } : {}),
  };
  assertDurableProtocolReceipt(receipt);
  return receipt;
}

export function durableProtocolReceipt(
  acknowledgement: Record<string, unknown>,
  credential: CredentialBinding,
  leaseKind?: LeaseAuthorizationKind,
) {
  const assignment =
    acknowledgement.assignment &&
    typeof acknowledgement.assignment === "object" &&
    !Array.isArray(acknowledgement.assignment)
      ? (acknowledgement.assignment as Record<string, unknown>)
      : undefined;
  const rawLeaseToken = assignment?.leaseToken;
  const assignmentId = assignment?.assignmentId;
  const leaseExpiresAt = assignment?.leaseExpiresAt;
  const leaseIssuedAt = assignment?.leaseIssuedAt;
  const fencingToken = assignment?.fencingToken;
  const leaseOwner = assignment?.leaseOwner;
  const responseChecksum = canonicalHash(acknowledgement);
  const runtimeTrust =
    missionControlRuntimeMode() === "disposable_acceptance" ? runtimeTrustReceiptBinding() : undefined;
  const base = {
    schemaVersion: "agent-protocol-receipt/2",
    status: "completed",
    protocolVersion: String(acknowledgement.protocolVersion ?? "1.0"),
    messageId: String(acknowledgement.messageId ?? ""),
    responseChecksum,
    ...(runtimeTrust ? { runtimeTrust } : {}),
  };
  if (typeof rawLeaseToken !== "string") {
    assertDurableProtocolReceipt(base);
    return base;
  }
  if (!leaseKind) throw new ValidationFailedError("Lease acknowledgement is missing its endpoint authority kind");
  if (
    typeof assignmentId !== "string" ||
    typeof leaseOwner !== "string" ||
    typeof leaseIssuedAt !== "string" ||
    !Number.isFinite(Date.parse(leaseIssuedAt)) ||
    typeof leaseExpiresAt !== "string" ||
    !Number.isFinite(Date.parse(leaseExpiresAt))
  )
    throw new ValidationFailedError("Lease acknowledgement is missing its non-secret receipt metadata");
  const executionId = typeof assignment?.executionId === "string" ? assignment.executionId : null;
  const operationId = typeof assignment?.operationId === "string" ? assignment.operationId : null;
  if (leaseKind === "execution_assignment" && !executionId)
    throw new ValidationFailedError("Execution lease acknowledgement is missing its execution binding");
  if (leaseKind === "project_brain_assignment" && !operationId)
    throw new ValidationFailedError("Project Brain lease acknowledgement is missing its operation binding");
  const tokenFingerprint = createHash("sha256").update(rawLeaseToken).digest("hex");
  const authorization = {
    schemaVersion: "lease-authorization-receipt/1",
    kind: leaseKind,
    leaseId: stableUuid(
      `lease-receipt:${credential.workspace_id}:${credential.agent_id}:${assignmentId}:${leaseKind}:${String(fencingToken ?? 0)}:${tokenFingerprint}`,
    ),
    tokenFingerprint,
    issuedAt: leaseIssuedAt,
    expiresAt: leaseExpiresAt,
    fencingToken: typeof fencingToken === "number" ? fencingToken : null,
    binding: {
      workspaceId: credential.workspace_id,
      agentId: credential.agent_id,
      credentialId: credential.credential_id,
      assignmentId,
      executionId,
      operationId,
      leaseOwner,
    },
  };
  const receipt = { ...base, authorization };
  assertDurableProtocolReceipt(receipt);
  return receipt;
}

export function assertDurableProtocolReceipt(value: unknown): asserts value is Record<string, unknown> {
  const receipt = record(value, "Protocol receipt");
  assertNoSecretFieldNames(receipt);
  if (receipt.status === "processing") {
    exactKeys(
      receipt,
      ["schemaVersion", "status", "protocolVersion", "messageId", "runtimeTrust"],
      "Processing receipt",
    );
  } else if (receipt.status === "completed") {
    exactKeys(
      receipt,
      ["schemaVersion", "status", "protocolVersion", "messageId", "responseChecksum", "authorization", "runtimeTrust"],
      "Completed receipt",
    );
  } else throw new ValidationFailedError("Protocol receipt status is invalid");
  if (receipt.schemaVersion !== "agent-protocol-receipt/2" || receipt.protocolVersion !== "1.0")
    throw new ValidationFailedError("Protocol receipt schema or protocol version is invalid");
  if (typeof receipt.messageId !== "string" || !receipt.messageId)
    throw new ValidationFailedError("Protocol receipt message ID is required");
  if (receipt.runtimeTrust !== undefined) {
    const trust = record(receipt.runtimeTrust, "Protocol receipt runtime trust");
    exactKeys(
      trust,
      [
        "schemaVersion",
        "runtimeMode",
        "disposable",
        "trustAuthority",
        "registryPath",
        "registryPathHash",
        "registryContentHash",
        "registryVersion",
        "registryScope",
      ],
      "Protocol receipt runtime trust",
    );
    const realProviderTrust =
      trust.trustAuthority === "disposable_exact_checksum_registry" &&
      trust.registryVersion === "mission-agent-disposable-acceptance/2" &&
      trust.registryScope === "consensus_real_provider_acceptance";
    const mockValidationTrust =
      trust.trustAuthority === "non_authenticated_candidate_validation" &&
      trust.registryVersion === "mission-agent-non-authenticated-candidate-validation/1" &&
      trust.registryScope === "non_authenticated_candidate_validation";
    if (
      trust.schemaVersion !== "mission-control-runtime-trust/1" ||
      trust.runtimeMode !== "disposable_acceptance" ||
      trust.disposable !== true ||
      typeof trust.registryPath !== "string" ||
      !trust.registryPath ||
      typeof trust.registryPathHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(trust.registryPathHash) ||
      typeof trust.registryContentHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(trust.registryContentHash) ||
      (!realProviderTrust && !mockValidationTrust)
    )
      throw new ValidationFailedError("Protocol receipt runtime trust binding is invalid");
  }
  if (receipt.status === "completed") {
    if (typeof receipt.responseChecksum !== "string" || !/^[a-f0-9]{64}$/.test(receipt.responseChecksum))
      throw new ValidationFailedError("Protocol receipt response checksum is invalid");
    if (receipt.authorization !== undefined) {
      const authorization = record(receipt.authorization, "Lease authorization receipt");
      exactKeys(
        authorization,
        ["schemaVersion", "kind", "leaseId", "tokenFingerprint", "issuedAt", "expiresAt", "fencingToken", "binding"],
        "Lease authorization receipt",
      );
      if (
        authorization.schemaVersion !== "lease-authorization-receipt/1" ||
        !["execution_assignment", "project_brain_assignment"].includes(String(authorization.kind)) ||
        typeof authorization.leaseId !== "string" ||
        !UUID_PATTERN.test(authorization.leaseId) ||
        typeof authorization.tokenFingerprint !== "string" ||
        !/^[a-f0-9]{64}$/.test(authorization.tokenFingerprint) ||
        !Number.isFinite(Date.parse(String(authorization.issuedAt))) ||
        !Number.isFinite(Date.parse(String(authorization.expiresAt))) ||
        Date.parse(String(authorization.expiresAt)) <= Date.parse(String(authorization.issuedAt)) ||
        !(
          authorization.fencingToken === null ||
          (Number.isSafeInteger(authorization.fencingToken) && Number(authorization.fencingToken) >= 0)
        )
      )
        throw new ValidationFailedError("Lease authorization receipt fields are invalid");
      const binding = record(authorization.binding, "Lease authorization binding");
      exactKeys(
        binding,
        ["workspaceId", "agentId", "credentialId", "assignmentId", "executionId", "operationId", "leaseOwner"],
        "Lease authorization binding",
      );
      for (const key of ["workspaceId", "agentId", "credentialId", "assignmentId", "leaseOwner"])
        if (typeof binding[key] !== "string" || !binding[key])
          throw new ValidationFailedError(`Lease authorization binding ${key} is required`);
      for (const key of ["workspaceId", "agentId", "credentialId", "assignmentId"])
        if (!UUID_PATTERN.test(String(binding[key])))
          throw new ValidationFailedError(`Lease authorization binding ${key} is invalid`);
      if (binding.executionId !== null && !UUID_PATTERN.test(String(binding.executionId)))
        throw new ValidationFailedError("Lease authorization execution binding is invalid");
      if (binding.operationId !== null && !UUID_PATTERN.test(String(binding.operationId)))
        throw new ValidationFailedError("Lease authorization operation binding is invalid");
      if (authorization.kind === "execution_assignment" && typeof binding.executionId !== "string")
        throw new ValidationFailedError("Execution lease receipt requires an execution binding");
      if (authorization.kind === "project_brain_assignment" && typeof binding.operationId !== "string")
        throw new ValidationFailedError("Project Brain lease receipt requires an operation binding");
    }
  }
}
