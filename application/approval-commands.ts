import type { PoolClient } from "pg";
import { appendEvents, loadAggregateEvents, type DomainEvent } from "@/lib/postgres-event-store";
import { NotFoundError, ValidationFailedError } from "@/lib/application-errors";
import { stableUuid } from "@/lib/stable-id";
import { getDatabasePool } from "@/lib/database";
import { canonicalHash } from "@/lib/canonical-json";
import { evaluateRemoteApproval } from "@/policy/remote-approval-policy";
import { handleCreateTask, handleTaskTransition } from "@/application/task-commands";
export async function requestRemoteApproval(input: {
  workspaceId: string;
  missionId: string;
  taskId: string;
  executionId: string;
  agentId: string;
  messageId: string;
  actionType: string;
  parameters: Record<string, unknown>;
  targetResource: string;
  riskExplanation: string;
  evidence: unknown[];
  expiresAt: string;
}) {
  const decision = evaluateRemoteApproval(input.actionType),
    actionHash = canonicalHash({
      actionType: input.actionType,
      parameters: input.parameters,
      targetResource: input.targetResource,
      executionId: input.executionId,
      agentId: input.agentId,
    });
  if (decision.outcome === "deny") return { outcome: "deny" as const, decision, actionHash };
  const approvalId = stableUuid(`remote-approval:${input.messageId}:${actionHash}`),
    result = await appendEvents({
      workspaceId: input.workspaceId,
      aggregateType: "approval",
      aggregateId: approvalId,
      missionId: input.missionId,
      expectedVersion: 0,
      commandId: stableUuid(`request-remote-approval:${input.messageId}:${actionHash}`),
      commandType: "RequestRemoteApproval",
      correlationId: input.missionId,
      actor: { type: "agent", id: input.agentId },
      events: [
        {
          eventType: "approval.requested",
          eventSchemaVersion: 1,
          payload: {
            taskId: input.taskId,
            executionId: input.executionId,
            agentId: input.agentId,
            approvalType: "remote_workflow",
            requestedAction: {
              actionType: input.actionType,
              parameters: input.parameters,
              targetResource: input.targetResource,
            },
            actionHash,
            riskExplanation: input.riskExplanation,
            riskLevel: "moderate",
            policyReasons: decision.reasons,
            policyVersion: decision.policyVersion,
            evidence: input.evidence,
            requestedBy: input.agentId,
            supportingEvidenceSummary: "Authenticated remote-agent recommendation and referenced evidence",
            expiresAt: input.expiresAt,
            status: "pending",
          },
        },
      ],
      applyProjections: applyApprovalProjection,
    });
  return { outcome: "require_approval" as const, approvalId, event: result.events[0], actionHash, decision };
}
export async function applyApprovalProjection(client: PoolClient, events: DomainEvent[]) {
  for (const e of events) {
    if (e.eventType === "approval.requested")
      await client.query(
        `INSERT INTO approval_projections(workspace_id,approval_id,mission_id,task_id,execution_id,aggregate_version,approval_type,requested_action,action_hash,risk_explanation,evidence,requested_by,status,created_at,supporting_evidence_summary,expires_at,action_request_id,agent_id,risk_level,policy_reasons,policy_version_at_request) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',$13,$14,$15,$16,$17,$18,$19,$20) ON CONFLICT(workspace_id,approval_id) DO UPDATE SET aggregate_version=EXCLUDED.aggregate_version,status='pending'`,
        [
          e.workspaceId,
          e.aggregateId,
          e.missionId,
          e.payload.taskId,
          e.payload.executionId ?? null,
          e.aggregateVersion,
          e.payload.approvalType,
          e.payload.requestedAction,
          e.payload.actionHash,
          e.payload.riskExplanation,
          JSON.stringify(e.payload.evidence),
          e.payload.requestedBy,
          e.occurredAt,
          e.payload.supportingEvidenceSummary,
          e.payload.expiresAt ?? null,
          e.payload.actionRequestId ?? null,
          e.payload.agentId ?? null,
          e.payload.riskLevel ?? null,
          JSON.stringify(e.payload.policyReasons ?? []),
          e.payload.policyVersion ?? null,
        ],
      );
    else if (e.eventType === "approval.decision_acknowledged")
      await client.query(
        "UPDATE approval_projections SET aggregate_version=$3,remote_decision_delivery_status='acknowledged',remote_decision_acknowledged_at=$4 WHERE workspace_id=$1 AND approval_id=$2",
        [e.workspaceId, e.aggregateId, e.aggregateVersion, e.occurredAt],
      );
    else if (e.eventType.startsWith("approval.")) {
      await client.query(
        "UPDATE approval_projections SET status=$3,aggregate_version=$4,decided_by=COALESCE($5,decided_by),decision_reason=COALESCE($6,decision_reason),decided_at=COALESCE(decided_at,$7),consumed_at=CASE WHEN $3='consumed' THEN $7 ELSE consumed_at END,policy_version_at_execution=COALESCE($8,policy_version_at_execution) WHERE workspace_id=$1 AND approval_id=$2",
        [
          e.workspaceId,
          e.aggregateId,
          e.payload.status,
          e.aggregateVersion,
          e.payload.decidedBy,
          e.payload.reason,
          e.occurredAt,
          e.payload.policyVersionAtExecution ?? null,
        ],
      );
      if (["approval.granted", "approval.denied", "approval.expired"].includes(e.eventType))
        await client.query(
          "UPDATE approval_projections SET remote_decision_delivery_status='pending' WHERE workspace_id=$1 AND approval_id=$2 AND approval_type='remote_workflow'",
          [e.workspaceId, e.aggregateId],
        );
    }
  }
}
export async function requestActionApproval(input: {
  workspaceId: string;
  missionId: string;
  taskId?: string;
  executionId?: string;
  agentId?: string;
  actionRequestId: string;
  actionType: string;
  targetResource: string;
  actionHash: string;
  approvalType: string;
  policyVersion: string;
  policyReasons: unknown[];
  evidence: unknown[];
  requestedBy: string;
  expiresAt: string;
}) {
  const approvalId = stableUuid(`action-approval:${input.actionRequestId}`);
  const result = await appendEvents({
    workspaceId: input.workspaceId,
    aggregateType: "approval",
    aggregateId: approvalId,
    missionId: input.missionId,
    expectedVersion: 0,
    commandId: stableUuid(`request-action-approval:${input.actionRequestId}`),
    commandType: "RequestActionApproval",
    correlationId: input.missionId,
    actor: { type: "agent", id: input.requestedBy },
    events: [
      {
        eventType: "approval.requested",
        eventSchemaVersion: 1,
        payload: {
          taskId: input.taskId,
          executionId: input.executionId,
          agentId: input.agentId,
          actionRequestId: input.actionRequestId,
          approvalType: input.approvalType,
          requestedAction: { actionType: input.actionType, targetResource: input.targetResource },
          actionHash: input.actionHash,
          riskExplanation: "External publication requires owner approval",
          riskLevel: "high",
          policyReasons: input.policyReasons,
          policyVersion: input.policyVersion,
          evidence: input.evidence,
          requestedBy: input.requestedBy,
          supportingEvidenceSummary: "Exact execution, branch, commit, remote, and policy evidence",
          expiresAt: input.expiresAt,
          status: "pending",
        },
      },
    ],
    applyProjections: applyApprovalProjection,
  });
  return result.events[0]?.aggregateId ?? approvalId;
}
export async function requestApproval(input: {
  workspaceId: string;
  missionId: string;
  taskId: string;
  key: string;
  actorId: string;
}) {
  const approvalId = stableUuid(`approval:${input.key}`);
  const result = await appendEvents({
    workspaceId: input.workspaceId,
    aggregateType: "approval",
    aggregateId: approvalId,
    missionId: input.missionId,
    expectedVersion: 0,
    commandId: stableUuid(`request:${input.key}`),
    commandType: "RequestApproval",
    correlationId: input.missionId,
    actor: { type: "scheduler", id: input.actorId },
    events: [
      {
        eventType: "approval.requested",
        eventSchemaVersion: 1,
        payload: {
          taskId: input.taskId,
          approvalType: "simulated_risk",
          requestedAction: { action: "continue_verification" },
          actionHash: input.key,
          riskExplanation: "Simulated production risk requires human review",
          evidence: [],
          requestedBy: input.actorId,
          supportingEvidenceSummary: "Recorded deterministic simulation evidence",
          status: "pending",
        },
      },
    ],
    outbox: [
      {
        eventIndex: 0,
        topic: "approval.events",
        idempotencyKey: `${input.key}:approval`,
        payload: { approvalId, missionId: input.missionId, taskId: input.taskId, eventType: "approval.requested" },
      },
    ],
    applyProjections: applyApprovalProjection,
  });
  return result.events[0]?.aggregateId ?? approvalId;
}
export async function decideApproval(input: {
  workspaceId: string;
  approvalId: string;
  granted: boolean;
  actorId: string;
  reason: string;
}) {
  const projection = (
    await getDatabasePool().query(
      "SELECT p.status,p.expires_at,p.approval_type,p.agent_id,p.execution_id,p.mission_id,p.task_id,p.action_hash,p.requested_action,(SELECT attempt FROM execution_projections e WHERE e.workspace_id=p.workspace_id AND e.execution_id=p.execution_id) attempt FROM approval_projections p WHERE p.workspace_id=$1 AND p.approval_id=$2",
      [input.workspaceId, input.approvalId],
    )
  ).rows[0];
  if (projection?.status === "pending" && projection.expires_at && new Date(projection.expires_at) <= new Date()) {
    await expireApproval({ workspaceId: input.workspaceId, approvalId: input.approvalId, actorId: "approval-expiry" });
    throw new ValidationFailedError("Approval has expired");
  }
  const events = await loadAggregateEvents({
    workspaceId: input.workspaceId,
    aggregateType: "approval",
    aggregateId: input.approvalId,
  });
  if (!events.length) throw new NotFoundError("Approval");
  const last = events.at(-1)!;
  if (["approval.granted", "approval.denied", "approval.expired"].includes(last.eventType))
    return { applied: false, event: last };
  const eventType = input.granted ? "approval.granted" : "approval.denied";
  const result = await appendEvents({
    workspaceId: input.workspaceId,
    aggregateType: "approval",
    aggregateId: input.approvalId,
    missionId: last.missionId,
    expectedVersion: last.aggregateVersion,
    commandId: stableUuid(`decision:${input.approvalId}:${input.granted}`),
    commandType: input.granted ? "GrantApproval" : "DenyApproval",
    correlationId: last.correlationId,
    causationId: last.eventId,
    actor: { type: "human", id: input.actorId },
    events: [
      {
        eventType,
        eventSchemaVersion: 1,
        payload: {
          status: input.granted ? "granted" : "denied",
          decidedBy: input.actorId,
          reason: input.reason,
          taskId: last.payload.taskId,
        },
      },
    ],
    outbox: [
      {
        eventIndex: 0,
        topic: projection.approval_type === "remote_workflow" ? "remote-agent.delivery" : "approval.resolved",
        idempotencyKey: `decision:${input.approvalId}`,
        payload:
          projection.approval_type === "remote_workflow"
            ? {
                messageId: stableUuid(`remote-approval-decision:${input.approvalId}:${eventType}`),
                agentId: projection.agent_id,
                messageType: input.granted ? "ApprovalGranted" : "ApprovalDenied",
                protocolVersion: "1.0",
                executionId: projection.execution_id,
                missionId: projection.mission_id,
                taskId: projection.task_id,
                approvalId: input.approvalId,
                decisionPayload: {
                  approvalId: input.approvalId,
                  missionId: projection.mission_id,
                  taskId: projection.task_id,
                  executionId: projection.execution_id,
                  attempt: projection.attempt,
                  actionHash: projection.action_hash,
                  requestedAction: projection.requested_action,
                  decision: input.granted ? "granted" : "denied",
                  reason: input.reason,
                },
              }
            : { approvalId: input.approvalId, missionId: last.missionId, taskId: last.payload.taskId, eventType },
      },
    ],
    applyProjections: applyApprovalProjection,
  });
  if (
    input.granted &&
    projection.approval_type === "remote_workflow" &&
    projection.requested_action?.actionType === "task.activate_codex"
  ) {
    const handoff = projection.requested_action.parameters?.handoff ?? {};
    const taskId = stableUuid(`remote-codex-task:${input.approvalId}`);
    await handleCreateTask({
      actor: { workspaceId: input.workspaceId, id: "mission-coordinator", type: "system" },
      commandId: stableUuid(`create-remote-codex-task:${input.approvalId}`),
      taskId,
      task: {
        missionId: projection.mission_id,
        name: String(handoff.recommendationTitle ?? "Implement approved Hermes recommendation"),
        instructions: [
          String(handoff.problemStatement ?? "Implement the approved bounded improvement."),
          `Suggested change: ${String(handoff.suggestedChange ?? "Apply the approved low-risk change.")}`,
          `Acceptance criteria: ${JSON.stringify(handoff.acceptanceCriteria ?? [])}`,
          `Test expectations: ${JSON.stringify(handoff.testExpectations ?? [])}`,
          `Explicit non-goals: ${JSON.stringify(handoff.nonGoals ?? [])}`,
        ].join("\n"),
        expectedOutput: String(handoff.expectedOutcome ?? "One tested local commit"),
        priority: "normal",
        riskLevel: "low",
        requiredCapabilities: ["repository.read", "repository.write", "code.implement", "test.run", "git.commit"],
        maximumAttempts: 1,
        timeoutSeconds: 600,
      },
    });
    await handleTaskTransition({
      actor: { workspaceId: input.workspaceId, id: "mission-coordinator", type: "system" },
      commandId: stableUuid(`activate-remote-codex-task:${input.approvalId}`),
      taskId,
      target: "ready",
      details: { approvalId: input.approvalId, sourceAgentId: projection.agent_id },
    });
  }
  return { applied: true, event: result.events[0] };
}

export async function consumeApproval(input: {
  workspaceId: string;
  approvalId: string;
  actorId: string;
  policyVersion: string;
}) {
  const events = await loadAggregateEvents({
    workspaceId: input.workspaceId,
    aggregateType: "approval",
    aggregateId: input.approvalId,
  });
  if (!events.length) throw new NotFoundError("Approval");
  const last = events.at(-1)!;
  if (last.eventType === "approval.consumed") return { applied: false, event: last };
  if (last.eventType !== "approval.granted") throw new Error("Approval is not granted");
  const result = await appendEvents({
    workspaceId: input.workspaceId,
    aggregateType: "approval",
    aggregateId: input.approvalId,
    missionId: last.missionId,
    expectedVersion: last.aggregateVersion,
    commandId: stableUuid(`consume:${input.approvalId}`),
    commandType: "ConsumeApproval",
    correlationId: last.correlationId,
    causationId: last.eventId,
    actor: { type: "system", id: input.actorId },
    events: [
      {
        eventType: "approval.consumed",
        eventSchemaVersion: 1,
        payload: {
          status: "consumed",
          decidedBy: last.payload.decidedBy,
          reason: "Consumed by exact approved action",
          taskId: last.payload.taskId,
          policyVersionAtExecution: input.policyVersion,
        },
      },
    ],
    applyProjections: async (client, events) => {
      await applyApprovalProjection(client, events);
      await client.query(
        "UPDATE approval_projections SET consumed_at=$3,policy_version_at_execution=$4 WHERE workspace_id=$1 AND approval_id=$2",
        [input.workspaceId, input.approvalId, events[0].occurredAt, input.policyVersion],
      );
    },
  });
  return { applied: true, event: result.events[0] };
}
export async function expireApproval(input: { workspaceId: string; approvalId: string; actorId: string }) {
  const events = await loadAggregateEvents({
    workspaceId: input.workspaceId,
    aggregateType: "approval",
    aggregateId: input.approvalId,
  });
  if (!events.length) throw new NotFoundError("Approval");
  const last = events.at(-1)!;
  if (last.eventType !== "approval.requested") return { applied: false, event: last };
  const result = await appendEvents({
    workspaceId: input.workspaceId,
    aggregateType: "approval",
    aggregateId: input.approvalId,
    missionId: last.missionId,
    expectedVersion: last.aggregateVersion,
    commandId: stableUuid(`expire:${input.approvalId}`),
    commandType: "ExpireApproval",
    correlationId: last.correlationId,
    causationId: last.eventId,
    actor: { type: "system", id: input.actorId },
    events: [
      {
        eventType: "approval.expired",
        eventSchemaVersion: 1,
        payload: { status: "expired", reason: "Approval validity window elapsed", taskId: last.payload.taskId },
      },
    ],
    applyProjections: applyApprovalProjection,
  });
  return { applied: true, event: result.events[0] };
}
