import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ValidationFailedError } from "@/lib/application-errors";

export const REMOTE_PROTOCOL_VERSION = "1.0" as const;
export const inboundMessageTypes = [
  "ExecutionAccepted",
  "ExecutionRejected",
  "ExecutionHeartbeat",
  "ExecutionProgressReported",
  "ExecutionArtifactSubmitted",
  "ExecutionApprovalRequested",
  "ExecutionPaused",
  "ExecutionResumed",
  "ExecutionSucceeded",
  "ExecutionFailed",
  "ExecutionCancellationAcknowledged",
  "AgentHeartbeat",
  "AgentCapabilitiesReported",
  "ApprovalDecisionAcknowledged",
  "AgentAssignmentPullRequested",
  "AgentAssignmentAcknowledged",
  "AgentAssignmentLeaseRenewed",
  "AgentAssignmentCancellationChecked",
  "AgentAssignmentReleased",
  "AgentRepositoryRegistered",
] as const;
export const outboundMessageTypes = [
  "ExecutionRequested",
  "ExecutionResumeRequested",
  "ExecutionCancellationRequested",
  "ApprovalGranted",
  "ApprovalDenied",
  "ApprovalExpired",
  "ApprovalCancelled",
  "AgentConfigurationChanged",
] as const;
export type InboundMessageType = (typeof inboundMessageTypes)[number];
export type OutboundMessageType = (typeof outboundMessageTypes)[number];
export type ProtocolEnvelope = {
  protocolVersion: "1.0";
  messageId: string;
  idempotencyKey: string;
  agentId: string;
  workspaceId: string;
  sentAt: string;
  messageType: InboundMessageType | OutboundMessageType;
  correlationId: string;
  missionId?: string;
  taskId?: string;
  executionId?: string;
  attempt?: number;
  payload: Record<string, unknown>;
};
export type ProtocolHeaders = {
  agentId: string;
  credentialId: string;
  timestamp: string;
  nonce: string;
  messageId: string;
  protocolVersion: string;
  bodyChecksum: string;
  signature: string;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const checksum = /^[0-9a-f]{64}$/;
export function sha256(body: string | Uint8Array) {
  return createHash("sha256")
    .update(typeof body === "string" ? body : Uint8Array.from(body))
    .digest("hex");
}
export function deriveSigningKey(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}
export function signatureInput(
  input: Omit<ProtocolHeaders, "agentId" | "credentialId" | "signature"> & { method: string; path: string },
) {
  return [
    input.method.toUpperCase(),
    input.path,
    input.timestamp,
    input.nonce,
    input.messageId,
    input.bodyChecksum.toLowerCase(),
    input.protocolVersion,
  ].join("\n");
}
export function signProtocolRequest(
  key: string,
  input: Omit<ProtocolHeaders, "agentId" | "credentialId" | "signature"> & { method: string; path: string },
) {
  return createHmac("sha256", key).update(signatureInput(input)).digest("hex");
}
export function safeSignatureEqual(expected: string, actual: string) {
  if (!checksum.test(expected) || !checksum.test(actual)) return false;
  return timingSafeEqual(Uint8Array.from(Buffer.from(expected, "hex")), Uint8Array.from(Buffer.from(actual, "hex")));
}
export function parseProtocolHeaders(request: Request): ProtocolHeaders {
  const value = (name: string) => request.headers.get(name)?.trim() ?? "";
  const result = {
    agentId: value("x-mc-agent-id"),
    credentialId: value("x-mc-credential-id"),
    timestamp: value("x-mc-timestamp"),
    nonce: value("x-mc-nonce"),
    messageId: value("x-mc-message-id"),
    protocolVersion: value("x-mc-protocol-version"),
    bodyChecksum: value("x-mc-body-sha256").toLowerCase(),
    signature: value("x-mc-signature").toLowerCase(),
  };
  if (
    !uuid.test(result.agentId) ||
    !uuid.test(result.credentialId) ||
    !uuid.test(result.messageId) ||
    !result.nonce ||
    !checksum.test(result.bodyChecksum) ||
    !checksum.test(result.signature)
  )
    throw new ValidationFailedError("Invalid agent protocol headers");
  return result;
}
export function validateEnvelope(
  value: unknown,
  expected: { agentId: string; workspaceId: string; messageId: string },
): ProtocolEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ValidationFailedError("Protocol body must be an object");
  const body = value as Record<string, unknown>;
  const allowed = new Set([
    "protocolVersion",
    "messageId",
    "idempotencyKey",
    "agentId",
    "workspaceId",
    "sentAt",
    "messageType",
    "correlationId",
    "missionId",
    "taskId",
    "executionId",
    "attempt",
    "payload",
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key)))
    throw new ValidationFailedError("Protocol body contains unsupported fields");
  if (
    body.protocolVersion !== REMOTE_PROTOCOL_VERSION ||
    !inboundMessageTypes.includes(body.messageType as InboundMessageType)
  )
    throw new ValidationFailedError("Unsupported protocol message");
  for (const key of ["messageId", "agentId", "workspaceId", "correlationId"] as const)
    if (typeof body[key] !== "string" || !uuid.test(body[key] as string))
      throw new ValidationFailedError(`Invalid ${key}`);
  if (
    body.agentId !== expected.agentId ||
    body.workspaceId !== expected.workspaceId ||
    body.messageId !== expected.messageId
  )
    throw new ValidationFailedError("Protocol identity mismatch");
  if (
    typeof body.idempotencyKey !== "string" ||
    body.idempotencyKey.length < 1 ||
    body.idempotencyKey.length > 200 ||
    typeof body.sentAt !== "string" ||
    !Number.isFinite(Date.parse(body.sentAt)) ||
    !body.payload ||
    typeof body.payload !== "object" ||
    Array.isArray(body.payload)
  )
    throw new ValidationFailedError("Invalid protocol envelope");
  const executionMessage = String(body.messageType).startsWith("Execution");
  if (
    executionMessage &&
    (![body.missionId, body.taskId, body.executionId].every(
      (id) => typeof id === "string" && uuid.test(id as string),
    ) ||
      !Number.isInteger(body.attempt) ||
      Number(body.attempt) < 1)
  )
    throw new ValidationFailedError("Execution correlation fields are required");
  return body as ProtocolEnvelope;
}
