import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { ValidationFailedError } from "@/lib/application-errors";
import { getDatabasePool } from "@/lib/database";
import { appendEvents, loadAggregateEvents, type DomainEvent } from "@/lib/postgres-event-store";

export type EmergencyControlKey =
  | "pause_new_executions"
  | "pause_remote_assignments"
  | "pause_codex_assignments"
  | "disable_all_schedules"
  | "stop_git_publication";
export type EmergencyActor = { workspaceId: string; userId: string; role: "owner" | "member" };
const allowed = new Set<EmergencyControlKey>([
  "pause_new_executions",
  "pause_remote_assignments",
  "pause_codex_assignments",
  "disable_all_schedules",
  "stop_git_publication",
]);
export async function applyEmergencyControlProjection(client: PoolClient, events: DomainEvent[]) {
  for (const event of events) {
    if (event.eventType === "workspace.remote_credentials_revoked") {
      await client.query(
        `INSERT INTO workspace_emergency_controls(workspace_id,aggregate_version,pause_remote_assignments,updated_by,reason,updated_at,last_event_position) VALUES($1,$2,true,$3,$4,$5,$6) ON CONFLICT(workspace_id) DO UPDATE SET aggregate_version=EXCLUDED.aggregate_version,pause_remote_assignments=true,updated_by=EXCLUDED.updated_by,reason=EXCLUDED.reason,updated_at=EXCLUDED.updated_at,last_event_position=EXCLUDED.last_event_position`,
        [
          event.workspaceId,
          event.aggregateVersion,
          event.actorId,
          event.payload.reason,
          event.occurredAt,
          event.position,
        ],
      );
      await client.query(
        `UPDATE agent_credentials SET status='revoked',revoked_at=$2 WHERE workspace_id=$1 AND status<>'revoked'`,
        [event.workspaceId, event.occurredAt],
      );
      await client.query(
        `UPDATE agents SET credential_status='revoked',status='disabled',updated_at=$2 WHERE workspace_id=$1 AND adapter_type='remote_http'`,
        [event.workspaceId, event.occurredAt],
      );
      continue;
    }
    if (event.eventType !== "workspace.emergency_control_changed") continue;
    const key = String(event.payload.control) as EmergencyControlKey;
    if (!allowed.has(key)) throw new ValidationFailedError("Unknown emergency control");
    await client.query(
      `INSERT INTO workspace_emergency_controls(workspace_id,aggregate_version,updated_by,reason,updated_at,last_event_position,${key}) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace_id) DO UPDATE SET aggregate_version=EXCLUDED.aggregate_version,updated_by=EXCLUDED.updated_by,reason=EXCLUDED.reason,updated_at=EXCLUDED.updated_at,last_event_position=EXCLUDED.last_event_position,${key}=EXCLUDED.${key}`,
      [
        event.workspaceId,
        event.aggregateVersion,
        event.actorId,
        event.payload.reason ?? null,
        event.occurredAt,
        event.position,
        Boolean(event.payload.enabled),
      ],
    );
  }
}
export async function emergencyControlState(workspaceId: string) {
  return (
    (await getDatabasePool().query(`SELECT * FROM workspace_emergency_controls WHERE workspace_id=$1`, [workspaceId]))
      .rows[0] ?? {
      workspace_id: workspaceId,
      aggregate_version: 0,
      pause_new_executions: false,
      pause_remote_assignments: false,
      pause_codex_assignments: false,
      disable_all_schedules: false,
      stop_git_publication: false,
    }
  );
}
export async function assertCapabilityEnabled(workspaceId: string, key: EmergencyControlKey) {
  const state = await emergencyControlState(workspaceId);
  if (state[key]) throw new ValidationFailedError(`Workspace emergency control is active: ${key}`);
}
export async function setEmergencyControl(input: {
  actor: EmergencyActor;
  commandId?: string;
  control: EmergencyControlKey;
  enabled: boolean;
  reason: string;
}) {
  if (input.actor.role !== "owner") throw new ValidationFailedError("Owner role is required");
  if (!allowed.has(input.control)) throw new ValidationFailedError("Unknown emergency control");
  if (!input.reason.trim()) throw new ValidationFailedError("An audit reason is required");
  const aggregateId = input.actor.workspaceId,
    existing = await loadAggregateEvents({
      workspaceId: input.actor.workspaceId,
      aggregateType: "workspace_emergency_controls",
      aggregateId,
    });
  return appendEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "workspace_emergency_controls",
    aggregateId,
    expectedVersion: existing.length,
    commandId: input.commandId ?? randomUUID(),
    commandType: "SetEmergencyControl",
    correlationId: aggregateId,
    causationId: existing.at(-1)?.eventId,
    actor: { type: "human", id: input.actor.userId },
    events: [
      {
        eventType: "workspace.emergency_control_changed",
        eventSchemaVersion: 1,
        payload: { control: input.control, enabled: input.enabled, reason: input.reason.trim() },
      },
    ],
    applyProjections: applyEmergencyControlProjection,
  });
}
export async function emergencyRevokeAllRemoteAgents(input: {
  actor: EmergencyActor;
  commandId?: string;
  reason: string;
}) {
  if (input.actor.role !== "owner") throw new ValidationFailedError("Owner role is required");
  if (!input.reason.trim()) throw new ValidationFailedError("An audit reason is required");
  const aggregateId = input.actor.workspaceId,
    existing = await loadAggregateEvents({
      workspaceId: input.actor.workspaceId,
      aggregateType: "workspace_emergency_controls",
      aggregateId,
    });
  return appendEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "workspace_emergency_controls",
    aggregateId,
    expectedVersion: existing.length,
    commandId: input.commandId ?? randomUUID(),
    commandType: "EmergencyRevokeAllRemoteAgents",
    correlationId: aggregateId,
    causationId: existing.at(-1)?.eventId,
    actor: { type: "human", id: input.actor.userId },
    events: [
      {
        eventType: "workspace.remote_credentials_revoked",
        eventSchemaVersion: 1,
        payload: { reason: input.reason.trim(), revokeAll: true },
      },
    ],
    applyProjections: applyEmergencyControlProjection,
  });
}
