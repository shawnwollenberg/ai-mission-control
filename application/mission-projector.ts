import type { PoolClient } from "pg";
import type { DomainEvent } from "@/lib/postgres-event-store";

export async function applyMissionProjection(client: PoolClient, events: DomainEvent[]): Promise<void> {
  for (const event of events) {
    if (event.eventType === "mission.created") {
      await client.query(
        `INSERT INTO mission_projections (
           workspace_id, mission_id, aggregate_version, name, objective, description, domain, priority, risk_level,
           status, requested_outcome, success_criteria, constraints, budget_limits, deadline, created_by,
           created_at, updated_at, last_event_position, template_id, template_version, resolved_inputs, resolved_task_plan, origin_schedule_id, intended_run_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft', $10, $11, $12, $13, $14, $15, $16, $16, $17, $18, $19, $20, $21, $22, $23)
         ON CONFLICT (workspace_id, mission_id) DO UPDATE SET
           aggregate_version = EXCLUDED.aggregate_version,
           name = EXCLUDED.name,
           objective = EXCLUDED.objective,
           description = EXCLUDED.description,
           domain = EXCLUDED.domain,
           priority = EXCLUDED.priority,
           risk_level = EXCLUDED.risk_level,
           status = EXCLUDED.status,
           requested_outcome = EXCLUDED.requested_outcome,
           success_criteria = EXCLUDED.success_criteria,
           constraints = EXCLUDED.constraints,
           budget_limits = EXCLUDED.budget_limits,
           deadline = EXCLUDED.deadline,
           created_by = EXCLUDED.created_by,
           created_at = EXCLUDED.created_at,
           updated_at = EXCLUDED.updated_at,
           template_id = EXCLUDED.template_id,
           template_version = EXCLUDED.template_version,
           resolved_inputs = EXCLUDED.resolved_inputs,
           resolved_task_plan = EXCLUDED.resolved_task_plan,
           origin_schedule_id = EXCLUDED.origin_schedule_id,
           intended_run_at = EXCLUDED.intended_run_at,
           last_event_position = EXCLUDED.last_event_position`,
        [
          event.workspaceId,
          event.aggregateId,
          event.aggregateVersion,
          event.payload.name,
          event.payload.objective,
          event.payload.description,
          event.payload.domain,
          event.payload.priority,
          event.payload.riskLevel,
          event.payload.requestedOutcome,
          JSON.stringify(event.payload.successCriteria),
          JSON.stringify(event.payload.constraints),
          JSON.stringify(event.payload.budgetLimits),
          event.payload.deadline,
          event.payload.createdBy,
          event.occurredAt,
          event.position,
          event.payload.templateId,
          event.payload.templateVersion,
          JSON.stringify(event.payload.resolvedInputs ?? {}),
          JSON.stringify(event.payload.resolvedTaskPlan ?? []),
          event.payload.originScheduleId,
          event.payload.intendedRunAt,
        ],
      );
      continue;
    }
    if (event.eventType.startsWith("mission.") && typeof event.payload.status === "string") {
      await client.query(
        `UPDATE mission_projections
         SET status = $3, aggregate_version = $4, updated_at = $5, last_event_position = $6
         WHERE workspace_id = $1 AND mission_id = $2`,
        [
          event.workspaceId,
          event.aggregateId,
          event.payload.status,
          event.aggregateVersion,
          event.occurredAt,
          event.position,
        ],
      );
    }
  }
}
