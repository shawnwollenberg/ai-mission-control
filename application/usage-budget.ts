import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { appendEvents, loadAggregateEvents, type DomainEvent } from "@/lib/postgres-event-store";
import { getDatabasePool } from "@/lib/database";
import { ValidationFailedError } from "@/lib/application-errors";
import { stableUuid } from "@/lib/stable-id";
import type { CommandActor } from "@/application/mission-commands";
import { applyApprovalProjection } from "@/application/approval-commands";
import { canonicalHash } from "@/lib/canonical-json";
import { applyNotificationProjection } from "@/application/notification-projector";

export type CostConfidence = "exact" | "provider_reported" | "estimated" | "unknown";
export async function recordUsage(input: {
  workspaceId: string;
  commandId: string;
  actorId: string;
  actorType?: "agent" | "system";
  missionId?: string;
  taskId?: string;
  executionId?: string;
  agentId?: string;
  scheduleId?: string;
  templateId?: string;
  templateVersion?: number;
  provider: string;
  runtime?: string;
  model?: string;
  metricType: string;
  quantity?: number;
  unit?: string;
  costAmount?: number;
  currency?: string;
  costConfidence: CostConfidence;
  source: string;
  repository?: string;
  domain?: string;
  recordedAt?: string;
}) {
  if (input.costConfidence === "unknown" && input.costAmount !== undefined)
    throw new ValidationFailedError("Unknown cost cannot contain an amount");
  if (input.actorType === "agent" && input.costConfidence === "exact")
    throw new ValidationFailedError("Agent-reported usage cannot be exact");
  const usageRecordId = stableUuid(`usage:${input.workspaceId}:${input.commandId}`);
  await appendEvents({
    workspaceId: input.workspaceId,
    aggregateType: "usage",
    aggregateId: usageRecordId,
    missionId: input.missionId,
    expectedVersion: 0,
    commandId: input.commandId,
    commandType: "RecordUsage",
    correlationId: input.missionId ?? usageRecordId,
    actor: { type: input.actorType ?? "system", id: input.actorId },
    events: [
      {
        eventType: "usage.recorded",
        eventSchemaVersion: 1,
        payload: {
          ...input,
          workspaceId: undefined,
          commandId: undefined,
          actorId: undefined,
          actorType: undefined,
          recordedAt: input.recordedAt ?? new Date().toISOString(),
        },
      },
    ],
    applyProjections: applyUsageProjection,
  });
  return { usageRecordId };
}
export async function applyUsageProjection(client: PoolClient, events: DomainEvent[]) {
  for (const event of events)
    if (event.eventType === "usage.recorded")
      await client.query(
        `INSERT INTO usage_records(workspace_id,usage_record_id,mission_id,task_id,execution_id,agent_id,schedule_id,template_id,template_version,provider,runtime,model,metric_type,quantity,unit,cost_amount,currency,cost_confidence,source,repository,domain,recorded_at,last_event_position) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) ON CONFLICT(workspace_id,usage_record_id) DO NOTHING`,
        [
          event.workspaceId,
          event.aggregateId,
          event.missionId ?? event.payload.missionId,
          event.payload.taskId,
          event.payload.executionId,
          event.payload.agentId,
          event.payload.scheduleId,
          event.payload.templateId,
          event.payload.templateVersion,
          event.payload.provider,
          event.payload.runtime,
          event.payload.model,
          event.payload.metricType,
          event.payload.quantity,
          event.payload.unit,
          event.payload.costAmount,
          event.payload.currency,
          event.payload.costConfidence,
          event.payload.source,
          event.payload.repository,
          event.payload.domain,
          event.payload.recordedAt,
          event.position,
        ],
      );
}

export async function setBudgetPolicy(input: {
  actor: CommandActor;
  commandId: string;
  budgetPolicyId?: string;
  resourceType: "mission" | "schedule" | "agent_daily" | "workspace_daily" | "workspace_monthly";
  resourceId?: string;
  currency?: string;
  warningAmount: number;
  hardLimitAmount: number;
  unknownCostBehavior?: "advisory" | "require_approval" | "trusted_runtime";
}) {
  if (input.actor.role !== "owner") throw new ValidationFailedError("Workspace owner permission is required");
  if (input.warningAmount < 0 || input.hardLimitAmount <= input.warningAmount)
    throw new ValidationFailedError("Budget hard limit must exceed its warning threshold");
  const id = input.budgetPolicyId ?? randomUUID();
  const existing = await loadAggregateEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "budget_policy",
    aggregateId: id,
  });
  await appendEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "budget_policy",
    aggregateId: id,
    expectedVersion: existing.length,
    commandId: input.commandId,
    commandType: "SetBudgetPolicy",
    correlationId: id,
    actor: { type: "human", id: input.actor.userId },
    events: [
      {
        eventType: "budget.policy_set",
        eventSchemaVersion: 1,
        payload: {
          resourceType: input.resourceType,
          resourceId: input.resourceId ?? null,
          currency: input.currency ?? "USD",
          warningAmount: input.warningAmount,
          hardLimitAmount: input.hardLimitAmount,
          unknownCostBehavior: input.unknownCostBehavior ?? "require_approval",
          enabled: true,
          policyVersion: existing.length + 1,
        },
      },
    ],
    applyProjections: applyBudgetProjection,
  });
  return { budgetPolicyId: id };
}
export async function applyBudgetProjection(client: PoolClient, events: DomainEvent[]) {
  for (const event of events) {
    if (event.eventType === "budget.policy_set")
      await client.query(
        `INSERT INTO budget_policies(workspace_id,budget_policy_id,resource_type,resource_id,currency,warning_amount,hard_limit_amount,unknown_cost_behavior,enabled,policy_version,aggregate_version,created_at,updated_at,last_event_position) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13) ON CONFLICT(workspace_id,budget_policy_id) DO UPDATE SET warning_amount=EXCLUDED.warning_amount,hard_limit_amount=EXCLUDED.hard_limit_amount,unknown_cost_behavior=EXCLUDED.unknown_cost_behavior,policy_version=EXCLUDED.policy_version,aggregate_version=EXCLUDED.aggregate_version,updated_at=EXCLUDED.updated_at,last_event_position=EXCLUDED.last_event_position`,
        [
          event.workspaceId,
          event.aggregateId,
          event.payload.resourceType,
          event.payload.resourceId,
          event.payload.currency,
          event.payload.warningAmount,
          event.payload.hardLimitAmount,
          event.payload.unknownCostBehavior,
          event.payload.enabled,
          event.payload.policyVersion,
          event.aggregateVersion,
          event.occurredAt,
          event.position,
        ],
      );
    else if (event.eventType === "budget.decision_recorded")
      await client.query(
        `INSERT INTO budget_decisions(workspace_id,budget_decision_id,budget_policy_id,mission_id,execution_id,decision,known_cost,unknown_cost_count,reason,created_at,last_event_position) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
        [
          event.workspaceId,
          event.aggregateId,
          event.payload.budgetPolicyId,
          event.payload.missionId,
          event.payload.executionId,
          event.payload.decision,
          event.payload.knownCost,
          event.payload.unknownCostCount,
          event.payload.reason,
          event.occurredAt,
          event.position,
        ],
      );
  }
}

export async function evaluateExecutionBudget(input: { workspaceId: string; missionId: string; executionId?: string }) {
  const policies = (
    await getDatabasePool().query(
      `SELECT * FROM budget_policies WHERE workspace_id=$1 AND enabled=true AND ((resource_type='mission' AND resource_id=$2) OR resource_type IN('workspace_daily','workspace_monthly'))`,
      [input.workspaceId, input.missionId],
    )
  ).rows;
  for (const policy of policies) {
    const period = policy.resource_type === "workspace_monthly" ? "month" : "day";
    const usage = (
      await getDatabasePool().query(
        `SELECT COALESCE(sum(cost_amount),0)::numeric known,count(*) FILTER(WHERE cost_confidence='unknown')::int unknown FROM usage_records WHERE workspace_id=$1 AND ($2::text<>'mission' OR mission_id=$3) AND recorded_at>=date_trunc($4,now())`,
        [input.workspaceId, policy.resource_type, input.missionId, period],
      )
    ).rows[0];
    const known = Number(usage.known),
      unknown = Number(usage.unknown);
    let decision: "allow" | "warn" | "deny" | "approval_required" =
      known >= Number(policy.hard_limit_amount) ? "deny" : known >= Number(policy.warning_amount) ? "warn" : "allow";
    if (unknown && policy.unknown_cost_behavior === "require_approval") decision = "approval_required";
    const reason =
      decision === "deny"
        ? "Hard budget limit reached"
        : decision === "warn"
          ? "Budget warning threshold reached"
          : decision === "approval_required"
            ? "Cost is unknown under a hard monetary budget"
            : "Within budget";
    const decisionId = stableUuid(
      `budget-decision:${policy.budget_policy_id}:${input.executionId ?? input.missionId}:${known}:${unknown}`,
    );
    const recorded = await appendEvents({
      workspaceId: input.workspaceId,
      aggregateType: "budget_decision",
      aggregateId: decisionId,
      missionId: input.missionId,
      expectedVersion: 0,
      commandId: decisionId,
      commandType: "EvaluateBudget",
      correlationId: input.missionId,
      actor: { type: "system", id: "budget-policy" },
      events: [
        {
          eventType: "budget.decision_recorded",
          eventSchemaVersion: 1,
          payload: {
            budgetPolicyId: policy.budget_policy_id,
            missionId: input.missionId,
            executionId: input.executionId ?? null,
            decision,
            knownCost: known,
            unknownCostCount: unknown,
            reason,
          },
        },
      ],
      applyProjections: applyBudgetProjection,
    });
    if (["warn", "deny", "approval_required"].includes(decision)) {
      const source = recorded.events[0],
        notificationId = stableUuid(`notification:${source.eventId}:budgets`);
      await appendEvents({
        workspaceId: input.workspaceId,
        aggregateType: "notification",
        aggregateId: notificationId,
        expectedVersion: 0,
        commandId: notificationId,
        commandType: "CreateBudgetNotification",
        correlationId: input.missionId,
        causationId: source.eventId,
        actor: { type: "system", id: "budget-policy" },
        events: [
          {
            eventType: "notification.created",
            eventSchemaVersion: 1,
            payload: {
              sourceEventId: source.eventId,
              category: "budgets",
              severity: decision === "warn" ? "warning" : "high",
              title: decision === "warn" ? "Budget warning threshold reached" : "Budget blocked new execution",
              summary: reason,
              missionId: input.missionId,
              scheduleId: null,
              approvalId: null,
            },
          },
        ],
        applyProjections: applyNotificationProjection,
      });
    }
    if (decision === "deny" || decision === "approval_required")
      throw new ValidationFailedError(reason, { budgetDecision: decision });
  }
  return { allowed: true };
}

export async function usageRollup(workspaceId: string) {
  return (
    await getDatabasePool().query(
      `SELECT COALESCE(sum(cost_amount) FILTER(WHERE cost_confidence='exact'),0)::numeric exact_cost,COALESCE(sum(cost_amount) FILTER(WHERE cost_confidence='provider_reported'),0)::numeric provider_reported_cost,COALESCE(sum(cost_amount) FILTER(WHERE cost_confidence='estimated'),0)::numeric estimated_cost,count(DISTINCT execution_id) FILTER(WHERE cost_confidence='unknown')::int unknown_cost_executions FROM usage_records WHERE workspace_id=$1`,
      [workspaceId],
    )
  ).rows[0];
}

export async function requestBudgetIncrease(input: {
  actor: CommandActor;
  commandId: string;
  budgetPolicyId: string;
  missionId: string;
  newLimit: number;
  expiresAt: string;
}) {
  const policy = (
    await getDatabasePool().query("SELECT * FROM budget_policies WHERE workspace_id=$1 AND budget_policy_id=$2", [
      input.actor.workspaceId,
      input.budgetPolicyId,
    ])
  ).rows[0];
  if (!policy) throw new ValidationFailedError("Budget policy does not exist");
  if (input.newLimit <= Number(policy.hard_limit_amount))
    throw new ValidationFailedError("Budget increase must be bounded above the previous limit");
  const requestedAction = {
    actionType: "budget.increase",
    budgetPolicyId: input.budgetPolicyId,
    previousLimit: Number(policy.hard_limit_amount),
    newLimit: input.newLimit,
    currency: policy.currency,
    expiresAt: input.expiresAt,
    policyVersion: policy.policy_version,
  };
  const actionHash = canonicalHash(requestedAction),
    approvalId = stableUuid(`budget-increase:${input.commandId}:${actionHash}`);
  await appendEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "approval",
    aggregateId: approvalId,
    missionId: input.missionId,
    expectedVersion: 0,
    commandId: input.commandId,
    commandType: "RequestBudgetIncrease",
    correlationId: input.missionId,
    actor: { type: "human", id: input.actor.userId },
    events: [
      {
        eventType: "approval.requested",
        eventSchemaVersion: 1,
        payload: {
          taskId: null,
          approvalType: "budget_increase",
          requestedAction,
          actionHash,
          riskExplanation: "A bounded monetary limit increase requires owner approval",
          evidence: [],
          requestedBy: input.actor.userId,
          supportingEvidenceSummary: "Exact previous/new limit, currency, expiry, and policy version",
          expiresAt: input.expiresAt,
          status: "pending",
          policyVersion: String(policy.policy_version),
        },
      },
    ],
    applyProjections: applyApprovalProjection,
  });
  return { approvalId, actionHash };
}
export async function applyApprovedBudgetIncrease(input: {
  actor: CommandActor;
  commandId: string;
  approvalId: string;
}) {
  const approval = (
    await getDatabasePool().query("SELECT * FROM approval_projections WHERE workspace_id=$1 AND approval_id=$2", [
      input.actor.workspaceId,
      input.approvalId,
    ])
  ).rows[0];
  if (!approval || approval.approval_type !== "budget_increase" || approval.status !== "granted")
    throw new ValidationFailedError("A current granted budget increase approval is required");
  if (approval.expires_at && new Date(approval.expires_at) <= new Date())
    throw new ValidationFailedError("Budget increase approval expired");
  const action = approval.requested_action,
    policy = (
      await getDatabasePool().query("SELECT * FROM budget_policies WHERE workspace_id=$1 AND budget_policy_id=$2", [
        input.actor.workspaceId,
        action.budgetPolicyId,
      ])
    ).rows[0];
  if (
    !policy ||
    Number(policy.hard_limit_amount) !== Number(action.previousLimit) ||
    policy.policy_version !== action.policyVersion
  )
    throw new ValidationFailedError("Budget policy changed after approval");
  return setBudgetPolicy({
    actor: input.actor,
    commandId: input.commandId,
    budgetPolicyId: policy.budget_policy_id,
    resourceType: policy.resource_type,
    resourceId: policy.resource_id,
    currency: policy.currency,
    warningAmount: Number(policy.warning_amount),
    hardLimitAmount: Number(action.newLimit),
    unknownCostBehavior: policy.unknown_cost_behavior,
  });
}
