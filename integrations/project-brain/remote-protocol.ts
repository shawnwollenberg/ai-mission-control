import { canonicalHash } from "@/lib/canonical-json";
import { ValidationFailedError } from "@/lib/application-errors";
import { projectBrainOperationPolicies } from "./governance";
import type { ProjectBrainOperation } from "./types";

const checksum = /^[a-f0-9]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha = /^[a-f0-9]{40,64}$/;
const operations = new Set(Object.keys(projectBrainOperationPolicies));

export type RemoteProjectBrainCapabilities = {
  installed: boolean;
  coreVersion: string;
  contractVersions: string[];
  schemaVersions: string[];
  operations: string[];
  readOperations: string[];
  writeOperations: string[];
  maxRequestBytes: number;
  maxResultBytes: number;
  artifactTransferModes: string[];
  runtimeReady: boolean;
  diagnosticsStatus: string;
};

export function validateRemoteProjectBrainCapabilities(value: unknown): RemoteProjectBrainCapabilities {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ValidationFailedError("Invalid remote Project Brain capabilities");
  const p = value as Record<string, unknown>;
  const strings = (candidate: unknown) =>
    Array.isArray(candidate) && candidate.every((item) => typeof item === "string");
  if (
    typeof p.installed !== "boolean" ||
    typeof p.coreVersion !== "string" ||
    !strings(p.contractVersions) ||
    !strings(p.schemaVersions) ||
    !strings(p.operations) ||
    !strings(p.readOperations) ||
    !strings(p.writeOperations) ||
    !Number.isInteger(p.maxRequestBytes) ||
    !Number.isInteger(p.maxResultBytes) ||
    Number(p.maxRequestBytes) < 1 ||
    Number(p.maxResultBytes) < 1 ||
    !strings(p.artifactTransferModes) ||
    typeof p.runtimeReady !== "boolean" ||
    typeof p.diagnosticsStatus !== "string" ||
    !(p.operations as string[]).every((operation) => operations.has(operation)) ||
    !(p.readOperations as string[]).every((operation) => (p.operations as string[]).includes(operation)) ||
    !(p.writeOperations as string[]).every((operation) => (p.operations as string[]).includes(operation)) ||
    !(p.operations as string[]).every(
      (operation) =>
        (p.readOperations as string[]).includes(operation) || (p.writeOperations as string[]).includes(operation),
    ) ||
    ((p.operations as string[]).includes("prepare_context") &&
      (!(p.readOperations as string[]).includes("prepare_context") ||
        !(p.writeOperations as string[]).includes("prepare_context")))
  )
    throw new ValidationFailedError("Invalid remote Project Brain capabilities");
  return p as RemoteProjectBrainCapabilities;
}

export function assertCompatibleRemoteProjectBrain(input: {
  capabilities: RemoteProjectBrainCapabilities | null;
  advertisedAt: Date | null;
  operation: ProjectBrainOperation;
  requiredVersion: string;
  requiredContract: string;
  requiredSchemas: string[];
  requestBytes: number;
  maxOutputBytes: number;
  now?: number;
}) {
  const reasons: string[] = [];
  if (!input.capabilities || !input.advertisedAt) reasons.push("remote_project_brain_capabilities_absent");
  else {
    if ((input.now ?? Date.now()) - input.advertisedAt.getTime() > 5 * 60_000)
      reasons.push("remote_project_brain_capabilities_stale");
    if (!input.capabilities.installed || !input.capabilities.runtimeReady)
      reasons.push("remote_project_brain_runtime_unavailable");
    if (input.capabilities.coreVersion !== input.requiredVersion)
      reasons.push("remote_project_brain_version_incompatible");
    if (!input.capabilities.contractVersions.includes(input.requiredContract))
      reasons.push("remote_project_brain_contract_incompatible");
    if (input.requiredSchemas.some((schema) => !input.capabilities!.schemaVersions.includes(schema)))
      reasons.push("remote_project_brain_schema_incompatible");
    if (!input.capabilities.operations.includes(input.operation))
      reasons.push("remote_project_brain_operation_unavailable");
    if (input.requestBytes > input.capabilities.maxRequestBytes) reasons.push("remote_project_brain_request_too_large");
    if (input.maxOutputBytes > input.capabilities.maxResultBytes)
      reasons.push("remote_project_brain_result_limit_unsupported");
    if (!input.capabilities.artifactTransferModes.includes("inline_base64"))
      reasons.push("remote_project_brain_artifact_transport_unsupported");
  }
  if (reasons.length) throw new ValidationFailedError("Remote Project Brain dispatch is blocked", { reasons });
}

export function validateRemoteProjectBrainRequest(value: Record<string, unknown>) {
  const requestedAt = Date.parse(String(value.requestedAt));
  const expiresAt = Date.parse(String(value.expiresAt));
  const optionalUuid = (candidate: unknown) =>
    candidate === null || (typeof candidate === "string" && uuid.test(candidate));
  if (
    value.protocolVersion !== "1.0" ||
    typeof value.requestId !== "string" ||
    !uuid.test(value.requestId) ||
    typeof value.idempotencyKey !== "string" ||
    value.idempotencyKey !== `project-brain:${String(value.operationId)}` ||
    typeof value.operationId !== "string" ||
    !uuid.test(value.operationId) ||
    typeof value.workspaceId !== "string" ||
    !uuid.test(value.workspaceId) ||
    typeof value.agentId !== "string" ||
    !uuid.test(value.agentId) ||
    typeof value.repositoryId !== "string" ||
    !uuid.test(value.repositoryId) ||
    !optionalUuid(value.missionId) ||
    !optionalUuid(value.executionId) ||
    typeof value.repositoryLocator !== "string" ||
    !/^mission-agent:\/\/[a-f0-9]{64}$/.test(value.repositoryLocator) ||
    value.repositoryLocator !== `mission-agent://${String(value.repositoryFingerprint)}` ||
    !operations.has(String(value.operation)) ||
    typeof value.startingSha !== "string" ||
    !sha.test(value.startingSha) ||
    !value.arguments ||
    typeof value.arguments !== "object" ||
    Array.isArray(value.arguments) ||
    typeof value.requiredProjectBrainVersion !== "string" ||
    typeof value.requiredContractVersion !== "string" ||
    !Array.isArray(value.requiredSchemaVersions) ||
    !value.requiredSchemaVersions.every((item) => typeof item === "string") ||
    !Array.isArray(value.requestedArtifactTypes) ||
    !value.requestedArtifactTypes.every((item) => typeof item === "string") ||
    !Number.isInteger(value.timeoutMs) ||
    Number(value.timeoutMs) < 1 ||
    Number(value.timeoutMs) > 3_600_000 ||
    !Number.isInteger(value.maxOutputBytes) ||
    Number(value.maxOutputBytes) < 1 ||
    Number(value.maxOutputBytes) > 10_000_000 ||
    !value.policyDecision ||
    typeof value.policyDecision !== "object" ||
    !value.authorization ||
    typeof value.authorization !== "object" ||
    typeof value.artifactVersioning !== "boolean" ||
    typeof value.requestedAt !== "string" ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(requestedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now() ||
    expiresAt <= requestedAt ||
    expiresAt - requestedAt > 3_600_000 ||
    typeof value.nonce !== "string" ||
    value.nonce.length < 16 ||
    value.nonce.length > 200 ||
    (value.approvalId !== null && (typeof value.approvalId !== "string" || !uuid.test(value.approvalId))) ||
    typeof value.approvalFingerprint !== "string" ||
    !checksum.test(value.approvalFingerprint) ||
    typeof value.requestChecksum !== "string" ||
    !checksum.test(String(value.requestChecksum)) ||
    typeof value.missionControlSignature !== "string" ||
    !checksum.test(String(value.missionControlSignature))
  )
    throw new ValidationFailedError("Invalid remote Project Brain operation request");
  const withoutChecksum = { ...value };
  delete withoutChecksum.requestChecksum;
  delete withoutChecksum.missionControlSignature;
  if (canonicalHash(withoutChecksum) !== value.requestChecksum)
    throw new ValidationFailedError("Remote Project Brain request checksum mismatch");
  return value;
}
