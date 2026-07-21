import { randomUUID } from "node:crypto";
import { applyNotificationProjection } from "@/application/notification-projector";
import { applyScheduleProjection } from "@/application/schedule-projector";
import { launchTemplate } from "@/application/template-commands";
import { dueOccurrences, nextRun, validateSchedule, type ScheduleRule } from "@/domain/schedule";
import { NotFoundError, ValidationFailedError } from "@/lib/application-errors";
import { getDatabasePool, withTransaction } from "@/lib/database";
import { appendEvents, loadAggregateEvents, type NewDomainEvent } from "@/lib/postgres-event-store";
import { stableUuid } from "@/lib/stable-id";
import type { CommandActor } from "@/application/mission-commands";

type ConcurrencyPolicy = "skip_if_running" | "queue_next" | "allow_parallel";
type MissedRunPolicy = "skip" | "run_once_on_recovery" | "run_all_with_limit";
type ScheduleRow = {
  workspace_id: string;
  schedule_id: string;
  template_id: string;
  template_version: number;
  inputs: Record<string, unknown>;
  schedule_rule: ScheduleRule;
  next_run_at: Date | string;
  maximum_active_runs: number;
  maximum_queued_runs: number;
  maximum_recovery_runs: number;
  concurrency_policy: ConcurrencyPolicy;
  missed_run_policy: MissedRunPolicy;
  created_by: string;
  name: string;
  timezone: string;
  enabled: boolean;
  paused: boolean;
  lease_owner: string;
};

function owner(actor: CommandActor) {
  if (actor.role !== "owner") throw new ValidationFailedError("Workspace owner permission is required");
}
async function scheduleRow(workspaceId: string, scheduleId: string): Promise<ScheduleRow & { deleted_at?: Date }> {
  const row = (
    await getDatabasePool().query("SELECT * FROM schedule_projections WHERE workspace_id=$1 AND schedule_id=$2", [
      workspaceId,
      scheduleId,
    ])
  ).rows[0];
  if (!row) throw new NotFoundError("Schedule");
  return row;
}

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
  concurrencyPolicy: ConcurrencyPolicy;
  missedRunPolicy: MissedRunPolicy;
  maximumActiveRuns?: number;
  maximumQueuedRuns?: number;
  maximumRecoveryRuns?: number;
  skipWarningThreshold?: number;
}) {
  owner(input.actor);
  validateSchedule(input.rule, input.timeZone);
  const template = (
    await getDatabasePool().query(
      "SELECT status FROM mission_template_projections WHERE workspace_id=$1 AND template_id=$2 AND version=$3",
      [input.actor.workspaceId, input.templateId, input.templateVersion],
    )
  ).rows[0];
  if (!template) throw new NotFoundError("Template version");
  if (template.status !== "published") throw new ValidationFailedError("Schedules require a published template");
  const scheduleId = input.scheduleId ?? randomUUID();
  const start = new Date(input.startAt ?? Date.now());
  const next = input.rule.type === "once" ? new Date(input.rule.at) : start;
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
          maximumQueuedRuns: input.maximumQueuedRuns ?? 1,
          maximumRecoveryRuns: input.maximumRecoveryRuns ?? 3,
          skipWarningThreshold: input.skipWarningThreshold ?? 3,
          createdBy: input.actor.userId,
        },
      },
    ],
    applyProjections: applyScheduleProjection,
  });
  return { scheduleId, nextRunAt: next.toISOString() };
}

async function control(input: {
  actor: CommandActor;
  commandId: string;
  scheduleId: string;
  eventType: string;
  commandType: string;
  payload: Record<string, unknown>;
}) {
  owner(input.actor);
  const events = await loadAggregateEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "schedule",
    aggregateId: input.scheduleId,
  });
  if (!events.length) throw new NotFoundError("Schedule");
  return appendEvents({
    workspaceId: input.actor.workspaceId,
    aggregateType: "schedule",
    aggregateId: input.scheduleId,
    expectedVersion: events.length,
    commandId: input.commandId,
    commandType: input.commandType,
    correlationId: input.scheduleId,
    actor: { type: "human", id: input.actor.userId },
    events: [{ eventType: input.eventType, eventSchemaVersion: 1, payload: input.payload }],
    applyProjections: applyScheduleProjection,
  });
}

export async function setScheduleEnabled(input: {
  actor: CommandActor;
  commandId: string;
  scheduleId: string;
  enabled: boolean;
}) {
  return control({
    ...input,
    eventType: input.enabled ? "schedule.enabled" : "schedule.disabled",
    commandType: input.enabled ? "EnableSchedule" : "DisableSchedule",
    payload: { enabled: input.enabled },
  });
}
export async function setSchedulePaused(input: {
  actor: CommandActor;
  commandId: string;
  scheduleId: string;
  paused: boolean;
}) {
  return control({
    ...input,
    eventType: input.paused ? "schedule.paused" : "schedule.resumed",
    commandType: input.paused ? "PauseSchedule" : "ResumeSchedule",
    payload: { paused: input.paused },
  });
}
export async function deleteSchedule(input: { actor: CommandActor; commandId: string; scheduleId: string }) {
  return control({
    ...input,
    eventType: "schedule.deleted",
    commandType: "DeleteSchedule",
    payload: { enabled: false },
  });
}
export async function updateSchedule(input: {
  actor: CommandActor;
  commandId: string;
  scheduleId: string;
  name?: string;
  templateVersion?: number;
  inputs?: Record<string, unknown>;
  timeZone?: string;
  rule?: ScheduleRule;
  concurrencyPolicy?: ConcurrencyPolicy;
  missedRunPolicy?: MissedRunPolicy;
  maximumActiveRuns?: number;
}) {
  const row = await scheduleRow(input.actor.workspaceId, input.scheduleId);
  const rule = input.rule ?? row.schedule_rule;
  const timeZone = input.timeZone ?? row.timezone;
  validateSchedule(rule, timeZone);
  if (input.templateVersion) {
    const exists = await getDatabasePool().query(
      "SELECT 1 FROM mission_template_projections WHERE workspace_id=$1 AND template_id=$2 AND version=$3 AND status='published'",
      [input.actor.workspaceId, row.template_id, input.templateVersion],
    );
    if (!exists.rowCount) throw new ValidationFailedError("Future schedule template version must be published");
  }
  return control({
    actor: input.actor,
    commandId: input.commandId,
    scheduleId: input.scheduleId,
    eventType: "schedule.updated",
    commandType: "UpdateSchedule",
    payload: {
      name: input.name ?? row.name,
      templateVersion: input.templateVersion ?? row.template_version,
      inputs: input.inputs ?? row.inputs,
      timeZone,
      rule,
      nextRunAt: nextRun(rule, new Date(), timeZone)?.toISOString() ?? null,
      concurrencyPolicy: input.concurrencyPolicy ?? row.concurrency_policy,
      missedRunPolicy: input.missedRunPolicy ?? row.missed_run_policy,
      maximumActiveRuns: input.maximumActiveRuns ?? row.maximum_active_runs,
    },
  });
}

export async function claimDueSchedule(workerId: string, leaseSeconds = 30, workspaceId?: string) {
  return withTransaction(async (client) => {
    const result = await client.query(
      `WITH due AS (
        SELECT s.workspace_id,s.schedule_id FROM schedule_projections s
        WHERE s.enabled=true AND s.paused=false AND s.deleted_at IS NULL
          AND ($3::uuid IS NULL OR s.workspace_id=$3)
          AND NOT EXISTS(SELECT 1 FROM workspace_emergency_controls c WHERE c.workspace_id=s.workspace_id AND c.disable_all_schedules=true)
          AND (s.lease_expires_at IS NULL OR s.lease_expires_at<now())
          AND (s.next_run_at<=now() OR EXISTS(
            SELECT 1 FROM schedule_run_projections r
            WHERE r.workspace_id=s.workspace_id AND r.schedule_id=s.schedule_id AND r.status='queued'
              AND NOT EXISTS(SELECT 1 FROM mission_projections m WHERE m.workspace_id=s.workspace_id AND m.origin_schedule_id=s.schedule_id AND m.status IN('draft','planned','running','paused'))
          ))
        ORDER BY s.next_run_at NULLS LAST FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE schedule_projections s SET lease_owner=$1,lease_expires_at=now()+($2*interval '1 second')
        FROM due WHERE s.workspace_id=due.workspace_id AND s.schedule_id=due.schedule_id RETURNING s.*`,
      [workerId, leaseSeconds, workspaceId ?? null],
    );
    return result.rows[0] as ScheduleRow | undefined;
  });
}

function runEvent(input: {
  row: ScheduleRow;
  intended: Date;
  status: "created" | "queued" | "skipped";
  triggerType: "scheduled" | "manual" | "recovery";
  reason?: string;
  nextRunAt?: string | null;
  coalesced?: number;
}) {
  const runId = stableUuid(
    `schedule-run:${input.row.schedule_id}:${input.intended.toISOString()}:${input.row.template_version}:${input.triggerType}`,
  );
  return {
    runId,
    missionId: stableUuid(`schedule-mission:${runId}`),
    event: {
      eventType: `schedule.run_${input.status}`,
      eventSchemaVersion: 1,
      payload: {
        scheduleRunId: runId,
        templateId: input.row.template_id,
        templateVersion: input.row.template_version,
        intendedRunAt: input.intended.toISOString(),
        missionId: input.status === "created" ? stableUuid(`schedule-mission:${runId}`) : null,
        status: input.status,
        reason: input.reason ?? null,
        nextRunAt: input.nextRunAt ?? null,
        triggerType: input.triggerType,
        concurrencyDecision: input.status,
        missedRunDecision: input.triggerType === "recovery" ? input.row.missed_run_policy : null,
        coalescedRunCount: input.coalesced ?? 0,
      },
    } satisfies NewDomainEvent,
  };
}

async function launch(row: ScheduleRow, runId: string, missionId: string, intended: Date) {
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
}

export async function runClaimedSchedule(row: ScheduleRow, workerId: string) {
  if (row.lease_owner !== workerId) throw new ValidationFailedError("Scheduler lease is not owned");
  const queued = (
    await getDatabasePool().query(
      "SELECT * FROM schedule_run_projections WHERE workspace_id=$1 AND schedule_id=$2 AND status='queued' ORDER BY intended_run_at LIMIT 1",
      [row.workspace_id, row.schedule_id],
    )
  ).rows[0];
  const active = Number(
    (
      await getDatabasePool().query(
        "SELECT count(*)::int total FROM mission_projections WHERE workspace_id=$1 AND origin_schedule_id=$2 AND status IN('draft','planned','running','paused')",
        [row.workspace_id, row.schedule_id],
      )
    ).rows[0].total,
  );
  if (queued && active === 0) {
    const aggregate = await loadAggregateEvents({
      workspaceId: row.workspace_id,
      aggregateType: "schedule",
      aggregateId: row.schedule_id,
    });
    const missionId = stableUuid(`schedule-mission:${queued.schedule_run_id}`);
    const released = await appendEvents({
      workspaceId: row.workspace_id,
      aggregateType: "schedule",
      aggregateId: row.schedule_id,
      expectedVersion: aggregate.length,
      commandId: stableUuid(`start-queued:${queued.schedule_run_id}`),
      commandType: "StartQueuedScheduleRun",
      correlationId: row.schedule_id,
      actor: { type: "scheduler", id: workerId },
      events: [
        {
          eventType: "schedule.run_created",
          eventSchemaVersion: 1,
          payload: {
            ...queued,
            scheduleRunId: queued.schedule_run_id,
            templateId: queued.template_id,
            templateVersion: queued.template_version,
            intendedRunAt: new Date(queued.intended_run_at).toISOString(),
            missionId,
            status: "created",
            reason: "queued run released",
            nextRunAt: row.next_run_at ? new Date(row.next_run_at).toISOString() : null,
            triggerType: queued.trigger_type,
            concurrencyDecision: "queue_released",
            missedRunDecision: queued.missed_run_decision,
            coalescedRunCount: queued.coalesced_run_count,
          },
        },
      ],
      applyProjections: applyScheduleProjection,
    });
    await launch(row, queued.schedule_run_id, missionId, new Date(queued.intended_run_at));
    await createScheduleNotification({
      row,
      sourceEventId: released.events[0].eventId,
      severity: "info",
      title: `Queued mission started: ${row.name}`,
      summary: "The bounded queued occurrence started after the prior mission became terminal.",
    });
    return { scheduleRunId: queued.schedule_run_id, missionId, status: "created", duplicate: false };
  }

  const now = new Date();
  const occurrences = dueOccurrences(row.schedule_rule, new Date(row.next_run_at), now, row.timezone, 1001);
  if (!occurrences.length) return { status: "idle", duplicate: false };
  let selected = occurrences;
  let skippedMissed: Date[] = [];
  const triggerType: "scheduled" | "recovery" = occurrences.length > 1 ? "recovery" : "scheduled";
  if (occurrences.length > 1 && row.missed_run_policy === "skip") {
    selected = [];
    skippedMissed = occurrences;
  } else if (occurrences.length > 1 && row.missed_run_policy === "run_once_on_recovery") {
    selected = [occurrences.at(-1)!];
    skippedMissed = occurrences.slice(0, -1);
  } else if (occurrences.length > row.maximum_recovery_runs) {
    selected = occurrences.slice(0, row.maximum_recovery_runs);
    skippedMissed = occurrences.slice(row.maximum_recovery_runs);
  }
  const following = nextRun(row.schedule_rule, occurrences.at(-1)!, row.timezone);
  const events: NewDomainEvent[] = [];
  if (skippedMissed.length && !selected.some((item) => item.getTime() === skippedMissed.at(-1)!.getTime()))
    events.push(
      runEvent({
        row,
        intended: skippedMissed.at(-1)!,
        status: "skipped",
        triggerType: "recovery",
        reason:
          row.missed_run_policy === "skip"
            ? `${skippedMissed.length} missed occurrences skipped`
            : `${skippedMissed.length} occurrences skipped at recovery limit`,
        nextRunAt: following?.toISOString() ?? null,
        coalesced: skippedMissed.length,
      }).event,
    );
  const launches: { runId: string; missionId: string; intended: Date }[] = [];
  let activeCount = active;
  const queuedCount = Number(
    (
      await getDatabasePool().query(
        "SELECT count(*)::int total FROM schedule_run_projections WHERE workspace_id=$1 AND schedule_id=$2 AND status='queued'",
        [row.workspace_id, row.schedule_id],
      )
    ).rows[0].total,
  );
  let pendingQueued = queuedCount;
  for (const intended of selected) {
    let status: "created" | "queued" | "skipped" = "created";
    let reason: string | undefined;
    if (activeCount >= row.maximum_active_runs) {
      if (row.concurrency_policy === "queue_next" && pendingQueued < row.maximum_queued_runs) {
        status = "queued";
        reason = "waiting for active scheduled mission";
        pendingQueued += 1;
      } else {
        status = "skipped";
        reason =
          row.concurrency_policy === "queue_next"
            ? "maximum queued runs reached; coalesced"
            : "maximum active runs reached";
      }
    }
    const built = runEvent({
      row,
      intended,
      status,
      triggerType,
      reason,
      nextRunAt: following?.toISOString() ?? null,
      coalesced: triggerType === "recovery" ? occurrences.length - 1 : 0,
    });
    events.push(built.event);
    if (status === "created") {
      launches.push({ runId: built.runId, missionId: built.missionId, intended });
      activeCount += 1;
    }
  }
  const aggregate = await loadAggregateEvents({
    workspaceId: row.workspace_id,
    aggregateType: "schedule",
    aggregateId: row.schedule_id,
  });
  const commandId = stableUuid(
    `schedule-batch:${row.schedule_id}:${occurrences[0].toISOString()}:${occurrences.at(-1)!.toISOString()}`,
  );
  const appended = await appendEvents({
    workspaceId: row.workspace_id,
    aggregateType: "schedule",
    aggregateId: row.schedule_id,
    expectedVersion: aggregate.length,
    commandId,
    commandType: "RunSchedule",
    correlationId: row.schedule_id,
    actor: { type: "scheduler", id: workerId },
    events,
    applyProjections: applyScheduleProjection,
  });
  if (appended.duplicateCommand) return { status: "duplicate", duplicate: true };
  for (const item of launches) {
    await launch(row, item.runId, item.missionId, item.intended);
    const source = appended.events.find((event) => event.payload.scheduleRunId === item.runId);
    if (source)
      await createScheduleNotification({
        row,
        sourceEventId: source.eventId,
        severity: "info",
        title: `Scheduled mission started: ${row.name}`,
        summary: "A scheduled mission instance was created through the standard command path.",
      });
  }
  const skipState = (
    await getDatabasePool().query(
      "SELECT consecutive_skips,skip_warning_threshold FROM schedule_projections WHERE workspace_id=$1 AND schedule_id=$2",
      [row.workspace_id, row.schedule_id],
    )
  ).rows[0];
  if (skipState.consecutive_skips >= skipState.skip_warning_threshold) {
    const source = appended.events.filter((event) => event.payload.status === "skipped").at(-1);
    if (source)
      await createScheduleNotification({
        row,
        sourceEventId: source.eventId,
        severity: "warning",
        title: `Schedule repeatedly skipped: ${row.name}`,
        summary: `${skipState.consecutive_skips} consecutive intended runs were skipped by deterministic concurrency or recovery policy.`,
      });
  }
  return {
    scheduleRunIds: events.map((event) => event.payload.scheduleRunId),
    missionIds: launches.map((item) => item.missionId),
    status: launches.length
      ? "created"
      : events.some((event) => event.payload.status === "queued")
        ? "queued"
        : "skipped",
    duplicate: false,
  };
}

export async function runScheduleNow(input: { actor: CommandActor; commandId: string; scheduleId: string }) {
  owner(input.actor);
  const row = await scheduleRow(input.actor.workspaceId, input.scheduleId);
  if (!row.enabled || row.deleted_at)
    throw new ValidationFailedError("Disabled or deleted schedules cannot run manually");
  const intended = new Date();
  const runId = stableUuid(`manual-schedule-run:${input.scheduleId}:${input.commandId}`);
  const missionId = stableUuid(`schedule-mission:${runId}`);
  const aggregate = await loadAggregateEvents({
    workspaceId: row.workspace_id,
    aggregateType: "schedule",
    aggregateId: row.schedule_id,
  });
  const result = await appendEvents({
    workspaceId: row.workspace_id,
    aggregateType: "schedule",
    aggregateId: row.schedule_id,
    expectedVersion: aggregate.length,
    commandId: input.commandId,
    commandType: "RunScheduleNow",
    correlationId: row.schedule_id,
    actor: { type: "human", id: input.actor.userId },
    events: [
      {
        eventType: "schedule.run_created",
        eventSchemaVersion: 1,
        payload: {
          scheduleRunId: runId,
          templateId: row.template_id,
          templateVersion: row.template_version,
          intendedRunAt: intended.toISOString(),
          missionId,
          status: "created",
          reason: null,
          nextRunAt: row.next_run_at ? new Date(row.next_run_at).toISOString() : null,
          triggerType: "manual",
          concurrencyDecision: "manual",
          missedRunDecision: null,
          coalescedRunCount: 0,
        },
      },
    ],
    applyProjections: applyScheduleProjection,
  });
  if (result.duplicateCommand) return { scheduleRunId: runId, missionId, duplicate: true };
  await launch(row, runId, missionId, intended);
  await createScheduleNotification({
    row,
    sourceEventId: result.events[0].eventId,
    severity: "info",
    title: `Manual schedule run started: ${row.name}`,
    summary: "An owner started a schedule through the durable run-now command.",
  });
  return { scheduleRunId: runId, missionId, duplicate: false };
}

export async function createScheduleNotification(input: {
  row: ScheduleRow;
  sourceEventId: string;
  severity: "info" | "warning" | "high";
  title: string;
  summary: string;
}) {
  const notificationId = stableUuid(`notification:${input.sourceEventId}:schedules`);
  return appendEvents({
    workspaceId: input.row.workspace_id,
    aggregateType: "notification",
    aggregateId: notificationId,
    expectedVersion: 0,
    commandId: stableUuid(`notify:${input.sourceEventId}:schedules`),
    commandType: "CreateNotification",
    correlationId: input.row.schedule_id,
    causationId: input.sourceEventId,
    actor: { type: "system", id: "notification-projector" },
    events: [
      {
        eventType: "notification.created",
        eventSchemaVersion: 1,
        payload: {
          sourceEventId: input.sourceEventId,
          category: "schedules",
          severity: input.severity,
          title: input.title,
          summary: input.summary,
          missionId: null,
          scheduleId: input.row.schedule_id,
          approvalId: null,
        },
      },
    ],
    applyProjections: applyNotificationProjection,
  });
}
