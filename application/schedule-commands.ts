import { randomUUID } from "node:crypto";
import { appendEvents, loadAggregateEvents } from "@/lib/postgres-event-store";
import { applyScheduleProjection } from "@/application/schedule-projector";
import { applyNotificationProjection } from "@/application/notification-projector";
import { validateSchedule, nextRun, type ScheduleRule } from "@/domain/schedule";
import { getDatabasePool, withTransaction } from "@/lib/database";
import { ValidationFailedError, NotFoundError } from "@/lib/application-errors";
import { stableUuid } from "@/lib/stable-id";
import { launchTemplate } from "@/application/template-commands";
import type { CommandActor } from "@/application/mission-commands";
export async function createSchedule(input: {
  actor: CommandActor;
  commandId: string;
  scheduleId?: string;
  name: string;
  templateId: string;
  templateVersion: number;
  inputs: Record<string, unknown>;
  timeZone: string;
  rule: ScheduleRule;
  enabled?: boolean;
  startAt?: string;
  endAt?: string;
  concurrencyPolicy: "skip_if_running" | "queue_next" | "allow_parallel";
  missedRunPolicy: "skip" | "run_once_on_recovery" | "run_all_with_limit";
  maximumActiveRuns?: number;
}) {
  if (input.actor.role !== "owner") throw new ValidationFailedError("Workspace owner permission is required");
  validateSchedule(input.rule, input.timeZone);
  const template = (
    await getDatabasePool().query(
      "SELECT status FROM mission_template_projections WHERE workspace_id=$1 AND template_id=$2 AND version=$3",
      [input.actor.workspaceId, input.templateId, input.templateVersion],
    )
  ).rows[0];
  if (!template) throw new NotFoundError("Template version");
  if (template.status !== "published") throw new ValidationFailedError("Schedules require a published template");
  const scheduleId = input.scheduleId ?? randomUUID(),
    start = new Date(input.startAt ?? Date.now()),
    next = input.rule.type === "once" ? new Date(input.rule.at) : start;
  await appendEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "schedule",
    aggregateId: scheduleId,
    expectedVersion: 0,
    commandId: input.commandId,
    commandType: "CreateSchedule",
    correlationId: scheduleId,
    actor: { type: "human", id: input.actor.userId },
    events: [
      {
        eventType: "schedule.created",
        eventSchemaVersion: 1,
        payload: {
          name: input.name,
          templateId: input.templateId,
          templateVersion: input.templateVersion,
          inputs: input.inputs,
          timeZone: input.timeZone,
          rule: input.rule,
          enabled: input.enabled ?? true,
          startAt: start.toISOString(),
          endAt: input.endAt ?? null,
          nextRunAt: next.toISOString(),
          concurrencyPolicy: input.concurrencyPolicy,
          missedRunPolicy: input.missedRunPolicy,
          maximumActiveRuns: input.maximumActiveRuns ?? 1,
          createdBy: input.actor.userId,
        },
      },
    ],
    applyProjections: applyScheduleProjection,
  });
  return { scheduleId, nextRunAt: next.toISOString() };
}
export async function setScheduleEnabled(input: {
  actor: CommandActor;
  commandId: string;
  scheduleId: string;
  enabled: boolean;
}) {
  const events = await loadAggregateEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "schedule",
    aggregateId: input.scheduleId,
  });
  if (!events.length) throw new NotFoundError("Schedule");
  await appendEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "schedule",
    aggregateId: input.scheduleId,
    expectedVersion: events.length,
    commandId: input.commandId,
    commandType: input.enabled ? "EnableSchedule" : "DisableSchedule",
    correlationId: input.scheduleId,
    actor: { type: "human", id: input.actor.userId },
    events: [
      {
        eventType: input.enabled ? "schedule.enabled" : "schedule.disabled",
        eventSchemaVersion: 1,
        payload: { enabled: input.enabled },
      },
    ],
    applyProjections: applyScheduleProjection,
  });
}
export async function claimDueSchedule(workerId: string, leaseSeconds = 30) {
  return withTransaction(
    async (client) =>
      (
        await client.query(
          `WITH due AS (SELECT workspace_id,schedule_id FROM schedule_projections WHERE enabled=true AND deleted_at IS NULL AND next_run_at<=now() AND (lease_expires_at IS NULL OR lease_expires_at<now()) ORDER BY next_run_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE schedule_projections s SET lease_owner=$1,lease_expires_at=now()+($2*interval '1 second') FROM due WHERE s.workspace_id=due.workspace_id AND s.schedule_id=due.schedule_id RETURNING s.*`,
          [workerId, leaseSeconds],
        )
      ).rows[0],
  );
}
type ClaimedSchedule = {
  workspace_id: string;
  schedule_id: string;
  template_id: string;
  template_version: number;
  inputs: Record<string, unknown>;
  schedule_rule: ScheduleRule;
  next_run_at: Date | string;
  maximum_active_runs: number;
  concurrency_policy: "skip_if_running" | "queue_next" | "allow_parallel";
  created_by: string;
  name: string;
  timezone: string;
  lease_owner: string;
};
export async function runClaimedSchedule(row: ClaimedSchedule, workerId: string) {
  if (row.lease_owner !== workerId) throw new ValidationFailedError("Scheduler lease is not owned");
  const intended = new Date(row.next_run_at),
    runId = stableUuid(`schedule-run:${row.schedule_id}:${intended.toISOString()}:${row.template_version}`),
    missionId = stableUuid(`schedule-mission:${runId}`);
  const existing = (
    await getDatabasePool().query(
      "SELECT mission_id,status FROM schedule_run_projections WHERE workspace_id=$1 AND schedule_run_id=$2",
      [row.workspace_id, runId],
    )
  ).rows[0];
  if (existing) return { scheduleRunId: runId, missionId: existing.mission_id, duplicate: true };
  const active = Number(
    (
      await getDatabasePool().query(
        "SELECT count(*)::int total FROM mission_projections WHERE workspace_id=$1 AND origin_schedule_id=$2 AND status IN('draft','planned','running','paused')",
        [row.workspace_id, row.schedule_id],
      )
    ).rows[0].total,
  );
  let status = "created",
    reason: string | undefined;
  if (active >= row.maximum_active_runs && row.concurrency_policy === "skip_if_running") {
    status = "skipped";
    reason = "maximum active runs reached";
  }
  const next = nextRun(row.schedule_rule, intended, row.timezone);
  const aggregate = await loadAggregateEvents({
    workspaceId: row.workspace_id,
    aggregateType: "schedule",
    aggregateId: row.schedule_id,
  });
  const appended = await appendEvents({
    workspaceId: row.workspace_id,
    aggregateType: "schedule",
    aggregateId: row.schedule_id,
    expectedVersion: aggregate.length,
    commandId: stableUuid(`schedule-run-command:${runId}`),
    commandType: "RunSchedule",
    correlationId: row.schedule_id,
    actor: { type: "scheduler", id: workerId },
    events: [
      {
        eventType: status === "created" ? "schedule.run_created" : "schedule.run_skipped",
        eventSchemaVersion: 1,
        payload: {
          scheduleRunId: runId,
          templateId: row.template_id,
          templateVersion: row.template_version,
          intendedRunAt: intended.toISOString(),
          missionId: status === "created" ? missionId : null,
          status,
          reason: reason ?? null,
          nextRunAt: next?.toISOString() ?? null,
        },
      },
    ],
    applyProjections: applyScheduleProjection,
  });
  if (status === "created") {
    await launchTemplate({
      actor: { workspaceId: row.workspace_id, userId: row.created_by, role: "owner" },
      commandId: stableUuid(`schedule-launch:${runId}`),
      templateId: row.template_id,
      version: row.template_version,
      inputs: row.inputs,
      missionId,
      originScheduleId: row.schedule_id,
      intendedRunAt: intended.toISOString(),
    });
    const source = appended.events[0];
    await appendEvents({
      workspaceId: row.workspace_id,
      aggregateType: "notification",
      aggregateId: stableUuid(`notification:${source.eventId}:schedule_run`),
      expectedVersion: 0,
      commandId: stableUuid(`notify:${source.eventId}`),
      commandType: "CreateNotification",
      correlationId: missionId,
      causationId: source.eventId,
      actor: { type: "system", id: "notification-projector" },
      events: [
        {
          eventType: "notification.created",
          eventSchemaVersion: 1,
          payload: {
            sourceEventId: source.eventId,
            category: "schedule_run",
            severity: "info",
            title: `Scheduled mission started: ${row.name}`,
            summary: "A scheduled mission instance was created through the standard command path.",
            missionId,
            scheduleId: row.schedule_id,
            approvalId: null,
          },
        },
      ],
      applyProjections: applyNotificationProjection,
    });
  }
  return { scheduleRunId: runId, missionId: status === "created" ? missionId : null, status, duplicate: false };
}
