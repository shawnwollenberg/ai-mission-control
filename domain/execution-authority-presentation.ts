import { ValidationFailedError } from "@/lib/application-errors";
import { canonicalHash } from "@/lib/canonical-json";

export const executionAuthorityPresentationSchemaVersion = "execution-authority-presentation/1" as const;
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;

export type ExecutionAuthorityPresentation = Readonly<{
  schemaVersion: typeof executionAuthorityPresentationSchemaVersion;
  workspaceId: string;
  parentMissionId: string;
  childMissionId: string;
  assignmentId: string;
  assignmentAttempt: number;
  providerAttemptId: string;
  agentId: string;
  providerId: string;
  requestedModelId: string;
  runtimeProfileId: string;
  runtimeProfileHash: string;
  executableIdentitySha256: string;
  executableSha256: string;
  authenticationBindingSha256: string;
  capabilityAttestationId: string;
  capabilityAttestationHash: string;
  repositoryId: string;
  repositorySnapshotSha256: string;
  repositoryAuthoritySha256: string;
  contextSha256: string | null;
  canonicalPlanSha256: string;
  leaseReceiptId: string;
  leaseTokenFingerprint: string;
  leaseOwner: string;
  fencingToken: number;
  operationIdentitySha256: string;
  resultAttemptIdentitySha256: string;
}>;

const keys: (keyof ExecutionAuthorityPresentation)[] = [
  "schemaVersion",
  "workspaceId",
  "parentMissionId",
  "childMissionId",
  "assignmentId",
  "assignmentAttempt",
  "providerAttemptId",
  "agentId",
  "providerId",
  "requestedModelId",
  "runtimeProfileId",
  "runtimeProfileHash",
  "executableIdentitySha256",
  "executableSha256",
  "authenticationBindingSha256",
  "capabilityAttestationId",
  "capabilityAttestationHash",
  "repositoryId",
  "repositorySnapshotSha256",
  "repositoryAuthoritySha256",
  "contextSha256",
  "canonicalPlanSha256",
  "leaseReceiptId",
  "leaseTokenFingerprint",
  "leaseOwner",
  "fencingToken",
  "operationIdentitySha256",
  "resultAttemptIdentitySha256",
];

export function parseExecutionAuthorityPresentation(value: unknown): ExecutionAuthorityPresentation {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ValidationFailedError("Execution authority presentation must be an object");
  const row = value as Record<string, unknown>;
  if (canonicalHash(Object.keys(row).sort()) !== canonicalHash([...keys].sort()))
    throw new ValidationFailedError("Execution authority presentation has an invalid schema");
  const presentation = row as unknown as ExecutionAuthorityPresentation;
  if (presentation.schemaVersion !== executionAuthorityPresentationSchemaVersion)
    throw new ValidationFailedError("Unsupported execution authority presentation schema");
  for (const field of [
    "workspaceId",
    "parentMissionId",
    "childMissionId",
    "assignmentId",
    "agentId",
    "capabilityAttestationId",
    "repositoryId",
    "leaseReceiptId",
  ] as const)
    if (!UUID.test(presentation[field])) throw new ValidationFailedError(`Invalid execution authority ${field}`);
  for (const field of [
    "providerAttemptId",
    "providerId",
    "requestedModelId",
    "runtimeProfileId",
    "leaseOwner",
  ] as const)
    if (!ID.test(presentation[field])) throw new ValidationFailedError(`Invalid execution authority ${field}`);
  for (const field of [
    "runtimeProfileHash",
    "executableIdentitySha256",
    "executableSha256",
    "authenticationBindingSha256",
    "capabilityAttestationHash",
    "repositorySnapshotSha256",
    "repositoryAuthoritySha256",
    "canonicalPlanSha256",
    "leaseTokenFingerprint",
    "operationIdentitySha256",
    "resultAttemptIdentitySha256",
  ] as const)
    if (!SHA.test(presentation[field])) throw new ValidationFailedError(`Invalid execution authority ${field}`);
  if (presentation.contextSha256 !== null && !SHA.test(presentation.contextSha256))
    throw new ValidationFailedError("Invalid execution authority contextSha256");
  if (!Number.isSafeInteger(presentation.assignmentAttempt) || presentation.assignmentAttempt < 1)
    throw new ValidationFailedError("Invalid execution authority assignmentAttempt");
  if (!Number.isSafeInteger(presentation.fencingToken) || presentation.fencingToken < 0)
    throw new ValidationFailedError("Invalid execution authority fencingToken");
  const serialized = JSON.stringify(presentation);
  if (/mc_(?:pb_)?lease_|bearer\s+|authorization|api[_-]?key|password|private[_-]?key/i.test(serialized))
    throw new ValidationFailedError("Execution authority presentation contains a forbidden secret");
  return presentation;
}

export const executionAuthorityPresentationIdentity = (value: ExecutionAuthorityPresentation) => canonicalHash(value);
