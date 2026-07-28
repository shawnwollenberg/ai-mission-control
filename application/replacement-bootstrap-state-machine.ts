import { createHash } from "node:crypto";
import { canonicalJson } from "../integrations/mission-agent/release-authority";
import { localReplacementOperations, type LocalReplacementOperation } from "./replacement-bootstrap-local-journal";

export const REPLACEMENT_PROVIDER = "local-macos-operator-v1" as const;

export type ReplacementExecutionState =
  | "claimed"
  | `ready:${LocalReplacementOperation}`
  | `intent:${LocalReplacementOperation}`
  | "awaiting-authoritative-smoke"
  | "rollback-required"
  | `rollback:${
      | "restore_artifact"
      | "restore_plist"
      | "restart_prior_service"
      | "verify_prior_runtime"
      | "verify_prior_identity"
      | "verify_prior_heartbeats"
      | "verify_prior_capabilities"
      | "verify_prior_projection"
      | "report_evidence"}`
  | "completed"
  | "rolled-back";

export type ReplacementOperationDefinition = {
  operation: LocalReplacementOperation;
  mutating: boolean;
  retrySafe: boolean;
  requiresHostReceipt: boolean;
  createsRollbackObligation: boolean;
  allowedDuringRecovery: boolean;
  allowedAfterExpiration: boolean;
};

const mutationOperations = new Set<LocalReplacementOperation>([
  "extract_node_runtime",
  "stop_service",
  "replace_artifact",
  "replace_plist",
  "start_service",
  "restore_artifact",
  "restore_plist",
  "restart_prior_service",
]);
const neverRetry = new Set<LocalReplacementOperation>([
  "stop_service",
  "replace_artifact",
  "replace_plist",
  "start_service",
  "restore_artifact",
  "restore_plist",
  "restart_prior_service",
]);
const rollbackOperations = new Set<LocalReplacementOperation>([
  "restore_artifact",
  "restore_plist",
  "restart_prior_service",
  "verify_prior_runtime",
  "verify_prior_identity",
  "verify_prior_heartbeats",
  "verify_prior_capabilities",
  "verify_prior_projection",
  "report_evidence",
]);

export const replacementOperationDefinitions: Readonly<
  Record<LocalReplacementOperation, ReplacementOperationDefinition>
> = Object.fromEntries(
  localReplacementOperations.map((operation) => [
    operation,
    {
      operation,
      mutating: mutationOperations.has(operation),
      retrySafe: !neverRetry.has(operation),
      requiresHostReceipt: operation !== "drain_agent",
      createsRollbackObligation: ["stop_service", "replace_artifact", "replace_plist", "start_service"].includes(
        operation,
      ),
      allowedDuringRecovery: mutationOperations.has(operation) || rollbackOperations.has(operation),
      allowedAfterExpiration: rollbackOperations.has(operation),
    },
  ]),
) as Record<LocalReplacementOperation, ReplacementOperationDefinition>;

export const replacementForwardOperations = [
  ...localReplacementOperations.slice(0, localReplacementOperations.indexOf("restore_artifact")),
  "report_evidence",
] as const satisfies readonly LocalReplacementOperation[];
export const replacementRollbackOperations = [
  "restore_artifact",
  "restore_plist",
  "restart_prior_service",
  "verify_prior_runtime",
  "verify_prior_identity",
  "verify_prior_heartbeats",
  "verify_prior_capabilities",
  "verify_prior_projection",
  "report_evidence",
] as const satisfies readonly LocalReplacementOperation[];

export function expectedOperation(input: {
  state: ReplacementExecutionState;
  lastAcceptedSequence: number;
}): LocalReplacementOperation | null {
  if (input.state === "claimed") return "inspect_host";
  if (input.state.startsWith("ready:") || input.state.startsWith("intent:"))
    return input.state.slice(input.state.indexOf(":") + 1) as LocalReplacementOperation;
  if (input.state === "rollback-required") return "restore_artifact";
  if (input.state.startsWith("rollback:")) return input.state.slice("rollback:".length) as LocalReplacementOperation;
  return null;
}

export function stateAfterAcceptedOperation(input: {
  state: ReplacementExecutionState;
  operation: LocalReplacementOperation;
  smokeAccepted: boolean;
}): ReplacementExecutionState {
  const expected = expectedOperation({ state: input.state, lastAcceptedSequence: 0 });
  if (expected !== input.operation)
    throw new Error(`Operation ${input.operation} is not permitted from ${input.state}.`);
  if (input.state === "rollback-required" || input.state.startsWith("rollback:")) {
    const index = replacementRollbackOperations.indexOf(
      input.operation as (typeof replacementRollbackOperations)[number],
    );
    if (index < 0) throw new Error("Forward progress is forbidden after rollback begins.");
    const next = replacementRollbackOperations[index + 1];
    return next ? `rollback:${next}` : "rolled-back";
  }
  const index = replacementForwardOperations.indexOf(input.operation);
  if (index < 0) throw new Error("Rollback operation is forbidden before rollback begins.");
  if (input.operation === "verify_capabilities") return "awaiting-authoritative-smoke";
  if (input.operation === "report_evidence") {
    if (!input.smokeAccepted) throw new Error("Completion requires authoritative smoke acceptance.");
    return "completed";
  }
  const next = replacementForwardOperations[index + 1];
  if (!next) throw new Error("Forward operation state has no successor.");
  return `ready:${next}`;
}

export function intentState(operation: LocalReplacementOperation): ReplacementExecutionState {
  if (!replacementOperationDefinitions[operation].mutating)
    throw new Error("A mutation intent cannot be created for a read-only operation.");
  return `intent:${operation}`;
}

export function fixedOperationChecksum(input: {
  operation: LocalReplacementOperation;
  authorizationFingerprint: string;
  executionId: string;
  claimGeneration: number;
}): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

export function fixedConditionChecksum(input: {
  operation: LocalReplacementOperation;
  condition: "precondition" | "postcondition";
  authorizationFingerprint: string;
}): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        conditionVersion: "replacement-fixed-condition-v1",
        operation: input.operation,
        condition: input.condition,
        authorizationFingerprint: input.authorizationFingerprint,
      }),
    )
    .digest("hex");
}
