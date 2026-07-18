import { ValidationFailedError } from "@/lib/application-errors";
export const EXECUTION_PROTOCOL_VERSION = "1.0" as const;
export type ExecutionRequest = {
  protocolVersion: "1.0";
  kind: "execution.request";
  executionId: string;
  missionId: string;
  taskId: string;
  workspaceId: string;
  agentId: string;
  attempt: number;
  objective: string;
  instructions: string;
  expectedOutput: string;
  constraints: string[];
  repository: { repositoryId: string; baseRef: string };
  approvalPolicy: { mergeRequired: boolean; deploymentRequired: boolean; destructiveActionRequired: boolean };
  timeoutSeconds: number;
  heartbeatIntervalSeconds: number;
  idempotencyKey: string;
};
export type AgentMessage = {
  protocolVersion: "1.0";
  kind:
    | "execution.acceptance"
    | "heartbeat"
    | "progress"
    | "command.result"
    | "artifact"
    | "approval.request"
    | "completion"
    | "failure"
    | "cancellation.acknowledgement";
  executionId: string;
  workspaceId: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ValidationFailedError("Protocol payload must be an object");
  return value as Record<string, unknown>;
}
function requiredString(row: Record<string, unknown>, key: string) {
  if (typeof row[key] !== "string" || !String(row[key]).trim())
    throw new ValidationFailedError(`Protocol field ${key} is required`);
  return String(row[key]);
}
export function validateExecutionRequest(value: unknown): ExecutionRequest {
  const row = object(value);
  if (row.protocolVersion !== EXECUTION_PROTOCOL_VERSION)
    throw new ValidationFailedError(`Unsupported execution protocol version: ${String(row.protocolVersion)}`);
  if (row.kind !== "execution.request") throw new ValidationFailedError("Invalid execution request kind");
  for (const key of ["executionId", "missionId", "taskId", "workspaceId", "agentId"]) {
    const id = requiredString(row, key);
    if (!uuid.test(id)) throw new ValidationFailedError(`Protocol field ${key} must be a UUID`);
  }
  requiredString(row, "objective");
  requiredString(row, "instructions");
  requiredString(row, "expectedOutput");
  requiredString(row, "idempotencyKey");
  if (
    !Number.isInteger(row.attempt) ||
    Number(row.attempt) < 1 ||
    !Number.isInteger(row.timeoutSeconds) ||
    Number(row.timeoutSeconds) < 1 ||
    !Number.isInteger(row.heartbeatIntervalSeconds) ||
    Number(row.heartbeatIntervalSeconds) < 1
  )
    throw new ValidationFailedError("Protocol numeric fields must be positive integers");
  if (!Array.isArray(row.constraints) || row.constraints.some((x) => typeof x !== "string"))
    throw new ValidationFailedError("Protocol constraints must be strings");
  const repository = object(row.repository),
    approvalPolicy = object(row.approvalPolicy);
  requiredString(repository, "repositoryId");
  requiredString(repository, "baseRef");
  for (const key of ["mergeRequired", "deploymentRequired", "destructiveActionRequired"])
    if (typeof approvalPolicy[key] !== "boolean")
      throw new ValidationFailedError(`Approval policy ${key} must be boolean`);
  return row as unknown as ExecutionRequest;
}
export function validateAgentMessage(value: unknown): AgentMessage {
  const row = object(value);
  if (row.protocolVersion !== EXECUTION_PROTOCOL_VERSION)
    throw new ValidationFailedError(`Unsupported execution protocol version: ${String(row.protocolVersion)}`);
  const kinds = new Set([
    "execution.acceptance",
    "heartbeat",
    "progress",
    "command.result",
    "artifact",
    "approval.request",
    "completion",
    "failure",
    "cancellation.acknowledgement",
  ]);
  if (!kinds.has(String(row.kind))) throw new ValidationFailedError("Unsupported protocol message kind");
  for (const key of ["executionId", "workspaceId", "idempotencyKey"]) requiredString(row, key);
  object(row.payload);
  return row as unknown as AgentMessage;
}
