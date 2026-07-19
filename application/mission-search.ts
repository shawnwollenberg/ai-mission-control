import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { appendEvents, loadAggregateEvents, type DomainEvent } from "@/lib/postgres-event-store";
import { getDatabasePool } from "@/lib/database";
import { ValidationFailedError } from "@/lib/application-errors";
import type { CommandActor } from "@/application/mission-commands";
export type MissionFilters = {
  query?: string;
  status?: string;
  domain?: string;
  templateId?: string;
  templateVersion?: number;
  scheduleId?: string;
  origin?: "manual" | "scheduled";
  agentId?: string;
  runtime?: string;
  repository?: string;
  approvalState?: string;
  from?: string;
  to?: string;
  failed?: boolean;
  blocked?: boolean;
  hasOpenPr?: boolean;
  hasUnknownCost?: boolean;
};
export async function searchMissions(workspaceId: string, filters: MissionFilters) {
  const values: unknown[] = [workspaceId];
  const where = ["m.workspace_id=$1"];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    where.push(sql.replace("?", `$${values.length}`));
  };
  if (filters.query) {
    values.push(`%${filters.query}%`);
    where.push(
      `(m.mission_id::text ILIKE $${values.length} OR m.name ILIKE $${values.length} OR m.objective ILIKE $${values.length})`,
    );
  }
  if (filters.status) add("m.status=?", filters.status);
  if (filters.domain) add("m.domain=?", filters.domain);
  if (filters.templateId) add("m.template_id=?", filters.templateId);
  if (filters.templateVersion) add("m.template_version=?", filters.templateVersion);
  if (filters.scheduleId) add("m.origin_schedule_id=?", filters.scheduleId);
  if (filters.origin === "manual") where.push("m.origin_schedule_id IS NULL");
  else if (filters.origin === "scheduled") where.push("m.origin_schedule_id IS NOT NULL");
  if (filters.failed) where.push("m.status='failed'");
  if (filters.from) add("m.created_at>=?", filters.from);
  if (filters.to) add("m.created_at<=?", filters.to);
  if (filters.agentId)
    add(
      "EXISTS(SELECT 1 FROM execution_projections e WHERE e.workspace_id=m.workspace_id AND e.mission_id=m.mission_id AND e.agent_id=?)",
      filters.agentId,
    );
  if (filters.runtime)
    add(
      "EXISTS(SELECT 1 FROM execution_projections e WHERE e.workspace_id=m.workspace_id AND e.mission_id=m.mission_id AND e.adapter_type=?)",
      filters.runtime,
    );
  if (filters.repository)
    add(
      "EXISTS(SELECT 1 FROM execution_projections e WHERE e.workspace_id=m.workspace_id AND e.mission_id=m.mission_id AND e.repository_id=?)",
      filters.repository,
    );
  if (filters.approvalState)
    add(
      "EXISTS(SELECT 1 FROM approval_projections p WHERE p.workspace_id=m.workspace_id AND p.mission_id=m.mission_id AND p.status=?)",
      filters.approvalState,
    );
  if (filters.blocked)
    where.push(
      "EXISTS(SELECT 1 FROM task_projections t WHERE t.workspace_id=m.workspace_id AND t.mission_id=m.mission_id AND t.status='blocked')",
    );
  if (filters.hasOpenPr)
    where.push(
      "EXISTS(SELECT 1 FROM action_request_projections a WHERE a.workspace_id=m.workspace_id AND a.mission_id=m.mission_id AND a.action_type='pull_request.create' AND a.status='succeeded')",
    );
  if (filters.hasUnknownCost)
    where.push(
      "EXISTS(SELECT 1 FROM usage_records u WHERE u.workspace_id=m.workspace_id AND u.mission_id=m.mission_id AND u.cost_confidence='unknown')",
    );
  return (
    await getDatabasePool().query(
      `SELECT m.* FROM mission_projections m WHERE ${where.join(" AND ")} ORDER BY m.updated_at DESC LIMIT 200`,
      values,
    )
  ).rows;
}
export async function saveView(input: {
  actor: CommandActor;
  commandId: string;
  savedViewId?: string;
  name: string;
  filters: MissionFilters;
  isDefault?: boolean;
  systemKey?: string;
}) {
  if (input.actor.role !== "owner") throw new ValidationFailedError("Workspace owner permission is required");
  const id = input.savedViewId ?? randomUUID();
  const existing = await loadAggregateEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "saved_view",
    aggregateId: id,
  });
  await appendEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "saved_view",
    aggregateId: id,
    expectedVersion: existing.length,
    commandId: input.commandId,
    commandType: "SaveView",
    correlationId: id,
    actor: { type: "human", id: input.actor.userId },
    events: [
      {
        eventType: existing.length ? "saved_view.updated" : "saved_view.created",
        eventSchemaVersion: 1,
        payload: {
          name: input.name,
          filters: input.filters,
          isDefault: input.isDefault ?? false,
          systemKey: input.systemKey ?? null,
        },
      },
    ],
    applyProjections: applySavedViewProjection,
  });
  return { savedViewId: id };
}
export async function deleteSavedView(input: { actor: CommandActor; commandId: string; savedViewId: string }) {
  const existing = await loadAggregateEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "saved_view",
    aggregateId: input.savedViewId,
  });
  await appendEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "saved_view",
    aggregateId: input.savedViewId,
    expectedVersion: existing.length,
    commandId: input.commandId,
    commandType: "DeleteSavedView",
    correlationId: input.savedViewId,
    actor: { type: "human", id: input.actor.userId },
    events: [{ eventType: "saved_view.deleted", eventSchemaVersion: 1, payload: {} }],
    applyProjections: applySavedViewProjection,
  });
}
export async function applySavedViewProjection(client: PoolClient, events: DomainEvent[]) {
  for (const event of events)
    if (event.eventType === "saved_view.created")
      await client.query(
        `INSERT INTO saved_view_projections(workspace_id,saved_view_id,name,filters,is_default,system_key,aggregate_version,created_at,updated_at,last_event_position) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$9) ON CONFLICT(workspace_id,saved_view_id) DO NOTHING`,
        [
          event.workspaceId,
          event.aggregateId,
          event.payload.name,
          JSON.stringify(event.payload.filters),
          event.payload.isDefault,
          event.payload.systemKey,
          event.aggregateVersion,
          event.occurredAt,
          event.position,
        ],
      );
    else if (event.eventType === "saved_view.updated")
      await client.query(
        `UPDATE saved_view_projections SET name=$3,filters=$4,is_default=$5,aggregate_version=$6,updated_at=$7,last_event_position=$8 WHERE workspace_id=$1 AND saved_view_id=$2`,
        [
          event.workspaceId,
          event.aggregateId,
          event.payload.name,
          JSON.stringify(event.payload.filters),
          event.payload.isDefault,
          event.aggregateVersion,
          event.occurredAt,
          event.position,
        ],
      );
    else if (event.eventType === "saved_view.deleted")
      await client.query(
        `UPDATE saved_view_projections SET deleted_at=$3,aggregate_version=$4,updated_at=$3,last_event_position=$5 WHERE workspace_id=$1 AND saved_view_id=$2`,
        [event.workspaceId, event.aggregateId, event.occurredAt, event.aggregateVersion, event.position],
      );
}
