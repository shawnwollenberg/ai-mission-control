import type { PoolClient } from "pg";
import { appendEvents, loadAggregateEvents, type DomainEvent } from "@/lib/postgres-event-store";
import { NotFoundError } from "@/lib/application-errors";
import { stableUuid } from "@/lib/stable-id";
export async function applyApprovalProjection(client: PoolClient, events: DomainEvent[]) {
  for (const e of events) {
    if (e.eventType === "approval.requested")
      await client.query(
        `INSERT INTO approval_projections(workspace_id,approval_id,mission_id,task_id,aggregate_version,approval_type,requested_action,action_hash,risk_explanation,evidence,requested_by,status,created_at,supporting_evidence_summary) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12,$13) ON CONFLICT(workspace_id,approval_id) DO UPDATE SET aggregate_version=EXCLUDED.aggregate_version,status='pending'`,
        [
          e.workspaceId,
          e.aggregateId,
          e.missionId,
          e.payload.taskId,
          e.aggregateVersion,
          e.payload.approvalType,
          e.payload.requestedAction,
          e.payload.actionHash,
          e.payload.riskExplanation,
          JSON.stringify(e.payload.evidence),
          e.payload.requestedBy,
          e.occurredAt,
          e.payload.supportingEvidenceSummary,
        ],
      );
    else if (e.eventType.startsWith("approval."))
      await client.query(
        "UPDATE approval_projections SET status=$3,aggregate_version=$4,decided_by=$5,decision_reason=$6,decided_at=$7 WHERE workspace_id=$1 AND approval_id=$2",
        [
          e.workspaceId,
          e.aggregateId,
          e.payload.status,
          e.aggregateVersion,
          e.payload.decidedBy,
          e.payload.reason,
          e.occurredAt,
        ],
      );
  }
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
        topic: "approval.resolved",
        idempotencyKey: `decision:${input.approvalId}`,
        payload: { approvalId: input.approvalId, missionId: last.missionId, taskId: last.payload.taskId, eventType },
      },
    ],
    applyProjections: applyApprovalProjection,
  });
  return { applied: true, event: result.events[0] };
}
