import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
const { getDatabasePool, closeDatabasePool } = await import("../lib/database.ts");
const { createTemplateVersion } = await import("../application/template-commands.ts");
const { createSchedule, claimDueSchedule, runClaimedSchedule, runScheduleNow, setScheduleEnabled } =
  await import("../application/schedule-commands.ts");
const { setNotificationPreferences } = await import("../application/notification-preferences.ts");
const { applyNotificationProjection } = await import("../application/notification-projector.ts");
const { appendEvents } = await import("../lib/postgres-event-store.ts");
const { claimNotificationDelivery, deliverNotification, ControlledNotificationProvider } =
  await import("../application/notification-delivery.ts");
const { recordUsage, setBudgetPolicy, evaluateExecutionBudget, usageRollup } =
  await import("../application/usage-budget.ts");
const { recordWorkerHeartbeat, workerHealth, requestWorkerShutdown } =
  await import("../application/worker-operations.ts");
const { detectOperationalAnomalies, requestProhibitedRemediation } =
  await import("../application/anomaly-operations.ts");
const { saveView, searchMissions } = await import("../application/mission-search.ts");
const { operationsDashboard } = await import("../application/operations-dashboard.ts");
const { handleMissionTransition } = await import("../application/mission-commands.ts");
const { enqueueJob, failJob } = await import("../lib/job-store.ts");
const { retryDeadLetter, reviewDeadLetter } = await import("../application/dead-letter-operations.ts");
const { runRetention } = await import("../application/retention.ts");
const { INITIAL_TEMPLATES } = await import("../templates/initial-templates.ts");
const workspaceId = randomUUID(),
  actor = { workspaceId, userId: "owner", role: "owner" };
let templateId;
test.before(async () => {
  await getDatabasePool().query("INSERT INTO workspaces(id,slug,name) VALUES($1,$2,'Phase 5 operations')", [
    workspaceId,
    `phase5-ops-${workspaceId}`,
  ]);
  const template = INITIAL_TEMPLATES.find((item) => item.definition.name === "Research and Writing");
  templateId = (
    await createTemplateVersion({ actor, commandId: randomUUID(), definition: template.definition, publish: true })
  ).templateId;
});
test.after(async () => {
  for (const table of [
    "notification_deliveries",
    "notification_projections",
    "notification_preferences",
    "anomaly_projections",
    "worker_projections",
    "budget_decisions",
    "budget_policies",
    "usage_records",
    "saved_view_projections",
    "schedule_run_projections",
    "schedule_projections",
    "outbox",
    "dead_letters",
    "jobs",
    "task_dependencies",
    "task_projections",
    "mission_projections",
    "mission_template_projections",
    "events",
    "commands",
    "aggregate_heads",
  ])
    await getDatabasePool().query(`DELETE FROM ${table} WHERE workspace_id=$1`, [workspaceId]);
  await getDatabasePool().query("DELETE FROM workspaces WHERE id=$1", [workspaceId]);
  await closeDatabasePool();
});
async function schedule(overrides = {}) {
  return createSchedule({
    actor,
    commandId: randomUUID(),
    name: `Schedule ${randomUUID()}`,
    templateId,
    templateVersion: 1,
    inputs: { topic: "operations", audience: "owner", desiredOutput: "report" },
    timeZone: "UTC",
    rule: { type: "once", at: new Date(Date.now() - 1000).toISOString() },
    startAt: new Date(Date.now() - 1000).toISOString(),
    concurrencyPolicy: "skip_if_running",
    missedRunPolicy: "run_once_on_recovery",
    ...overrides,
  });
}

test("schedule concurrency, run-now, disabled controls, and recovery are bounded and idempotent", async () => {
  const first = await schedule();
  const claimed = await claimDueSchedule("policy-worker");
  await runClaimedSchedule(claimed, "policy-worker");
  await getDatabasePool().query(
    "UPDATE schedule_projections SET next_run_at=now()-interval '1 second',schedule_rule=$3 WHERE workspace_id=$1 AND schedule_id=$2",
    [workspaceId, first.scheduleId, { type: "hourly" }],
  );
  const skipClaim = await claimDueSchedule("skip-worker");
  const skipped = await runClaimedSchedule(skipClaim, "skip-worker");
  assert.equal(skipped.status, "skipped");
  assert.equal(
    (
      await getDatabasePool().query(
        "SELECT count(*)::int n FROM schedule_run_projections WHERE workspace_id=$1 AND schedule_id=$2 AND status='skipped'",
        [workspaceId, first.scheduleId],
      )
    ).rows[0].n,
    1,
  );

  const queuedSchedule = await schedule({ concurrencyPolicy: "queue_next" });
  const q1 = await claimDueSchedule("queue-a");
  const q1Result = await runClaimedSchedule(q1, "queue-a");
  await getDatabasePool().query(
    "UPDATE schedule_projections SET next_run_at=now()-interval '1 second',schedule_rule=$3 WHERE workspace_id=$1 AND schedule_id=$2",
    [workspaceId, queuedSchedule.scheduleId, { type: "hourly" }],
  );
  const q2 = await claimDueSchedule("queue-b");
  assert.equal((await runClaimedSchedule(q2, "queue-b")).status, "queued");
  await getDatabasePool().query(
    "UPDATE schedule_projections SET next_run_at=now()-interval '1 second' WHERE workspace_id=$1 AND schedule_id=$2",
    [workspaceId, queuedSchedule.scheduleId],
  );
  const q3 = await claimDueSchedule("queue-c");
  await runClaimedSchedule(q3, "queue-c");
  assert.equal(
    (
      await getDatabasePool().query(
        "SELECT count(*)::int n FROM schedule_run_projections WHERE workspace_id=$1 AND schedule_id=$2 AND status='queued'",
        [workspaceId, queuedSchedule.scheduleId],
      )
    ).rows[0].n,
    1,
  );
  await handleMissionTransition({
    actor,
    commandId: randomUUID(),
    missionId: q1Result.missionIds[0],
    target: "cancelled",
  });
  const release = await claimDueSchedule("queue-release");
  const released = await runClaimedSchedule(release, "queue-release");
  assert.equal(released.status, "created");
  assert.equal(
    (
      await getDatabasePool().query(
        "SELECT count(*)::int n FROM schedule_run_projections WHERE workspace_id=$1 AND schedule_id=$2 AND status='queued'",
        [workspaceId, queuedSchedule.scheduleId],
      )
    ).rows[0].n,
    0,
  );

  const manual = await schedule({
    rule: { type: "once", at: new Date(Date.now() + 3600000).toISOString() },
    startAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const commandId = randomUUID();
  const one = await runScheduleNow({ actor, commandId, scheduleId: manual.scheduleId });
  const two = await runScheduleNow({ actor, commandId, scheduleId: manual.scheduleId });
  assert.equal(one.missionId, two.missionId);
  assert.equal(two.duplicate, true);
  await setScheduleEnabled({ actor, commandId: randomUUID(), scheduleId: manual.scheduleId, enabled: false });
  await assert.rejects(runScheduleNow({ actor, commandId: randomUUID(), scheduleId: manual.scheduleId }), /Disabled/);

  const recovery = await schedule({
    rule: { type: "hourly" },
    startAt: new Date(Date.now() - 5 * 3600000).toISOString(),
    concurrencyPolicy: "allow_parallel",
    maximumActiveRuns: 3,
    missedRunPolicy: "run_all_with_limit",
    maximumRecoveryRuns: 3,
  });
  const r = await claimDueSchedule("recovery");
  await runClaimedSchedule(r, "recovery");
  const history = (
    await getDatabasePool().query(
      "SELECT status FROM schedule_run_projections WHERE workspace_id=$1 AND schedule_id=$2",
      [workspaceId, recovery.scheduleId],
    )
  ).rows;
  assert.equal(history.filter((x) => x.status === "created").length, 3);
  assert.ok(history.filter((x) => x.status === "skipped").length >= 1);
});

test("notification preferences enforce categories, severity, quiet hours, idempotency, and safe retry", async () => {
  await setNotificationPreferences({
    actor,
    commandId: randomUUID(),
    inAppEnabled: true,
    emailEnabled: true,
    outboundEnabled: false,
    deliveryMode: "immediate",
    minimumSeverity: "warning",
    categories: ["worker_status"],
    quietHoursStart: "00:00",
    quietHoursEnd: "23:59",
    timeZone: "UTC",
    dailyDigestTime: "09:00",
    highSeverityOverride: true,
    emailDestinationRef: "email:test-destination",
  });
  const source = randomUUID(),
    notificationId = randomUUID();
  const create = () =>
    appendEvents({
      workspaceId,
      aggregateType: "notification",
      aggregateId: notificationId,
      expectedVersion: 0,
      commandId: notificationId,
      commandType: "notify",
      correlationId: notificationId,
      actor: { type: "system", id: "test" },
      events: [
        {
          eventType: "notification.created",
          eventSchemaVersion: 1,
          payload: {
            sourceEventId: source,
            category: "worker_status",
            severity: "warning",
            title: "Worker stale",
            summary: "Safe summary",
            missionId: null,
            scheduleId: null,
            approvalId: null,
          },
        },
      ],
      applyProjections: applyNotificationProjection,
    });
  await create();
  await create();
  assert.equal(
    (
      await getDatabasePool().query(
        "SELECT count(*)::int n FROM notification_projections WHERE workspace_id=$1 AND notification_id=$2",
        [workspaceId, notificationId],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await getDatabasePool().query(
        "SELECT status FROM notification_deliveries WHERE workspace_id=$1 AND notification_id=$2",
        [workspaceId, notificationId],
      )
    ).rows[0].status,
    "digest_pending",
  );
  await getDatabasePool().query(
    "UPDATE notification_deliveries SET status='pending',destination_ref='email:fail' WHERE workspace_id=$1 AND notification_id=$2",
    [workspaceId, notificationId],
  );
  const delivery = await claimNotificationDelivery("notification-test");
  assert.equal((await deliverNotification(delivery, new ControlledNotificationProvider())).status, "retrying");
});

test("usage confidence, cost rollups, budgets, worker health, dashboard, and remediation denial remain deterministic", async () => {
  const missionId = (
    await getDatabasePool().query("SELECT mission_id FROM mission_projections WHERE workspace_id=$1 LIMIT 1", [
      workspaceId,
    ])
  ).rows[0].mission_id;
  await recordUsage({
    workspaceId,
    commandId: randomUUID(),
    actorId: "codex",
    missionId,
    executionId: randomUUID(),
    provider: "openai",
    runtime: "codex",
    metricType: "duration",
    quantity: 100,
    unit: "milliseconds",
    costConfidence: "unknown",
    source: "test",
  });
  await recordUsage({
    workspaceId,
    commandId: randomUUID(),
    actorId: "hermes",
    actorType: "agent",
    missionId,
    executionId: randomUUID(),
    provider: "hermes",
    runtime: "hermes",
    metricType: "tokens",
    quantity: 50,
    unit: "tokens",
    costAmount: 9,
    currency: "USD",
    costConfidence: "provider_reported",
    source: "agent_report",
  });
  const rollup = await usageRollup(workspaceId);
  assert.equal(Number(rollup.provider_reported_cost), 9);
  assert.equal(rollup.unknown_cost_executions, 1);
  await setBudgetPolicy({
    actor,
    commandId: randomUUID(),
    resourceType: "mission",
    resourceId: missionId,
    warningAmount: 5,
    hardLimitAmount: 8,
    unknownCostBehavior: "advisory",
  });
  await assert.rejects(evaluateExecutionBudget({ workspaceId, missionId, executionId: randomUUID() }), /Hard budget/);
  await recordWorkerHeartbeat({
    workspaceId,
    workerId: "scheduler-test",
    workerType: "scheduler",
    heartbeatIntervalSeconds: 10,
    readiness: { database: { ok: true, summary: "available" } },
  });
  assert.equal((await workerHealth(workspaceId))[0].calculated_status, "active");
  await getDatabasePool().query(
    "UPDATE worker_projections SET last_heartbeat=now()-interval '100 seconds' WHERE workspace_id=$1",
    [workspaceId],
  );
  const anomalies = await detectOperationalAnomalies(workspaceId);
  assert.equal(anomalies.length, 1);
  const denied = await requestProhibitedRemediation({
    actor,
    commandId: randomUUID(),
    anomalyId: anomalies[0],
    recommendation: "Restart worker",
  });
  assert.deepEqual(denied, { denied: true, executed: false });
  await saveView({ actor, commandId: randomUUID(), name: "Unknown", filters: { hasUnknownCost: true } });
  assert.ok((await searchMissions(workspaceId, { hasUnknownCost: true })).length >= 1);
  const dashboard = await operationsDashboard(workspaceId);
  assert.ok(Number(dashboard.attention.budget_blocks) >= 1);
  assert.equal(dashboard.usage.unknown_cost_executions, 1);
  await requestWorkerShutdown({ workspaceId, workerId: "scheduler-test", graceful: true, commandId: randomUUID() });
  assert.equal((await workerHealth(workspaceId))[0].calculated_status, "stopping");
});

test("dead letters remain durable and bounded retention removes only resolved operational data", async () => {
  const jobId = await enqueueJob({
    workspaceId,
    jobType: "simulate_task",
    idempotencyKey: randomUUID(),
    payload: { safe: true },
    maxAttempts: 1,
  });
  await getDatabasePool().query(
    "UPDATE jobs SET status='processing',attempt_count=1,lease_owner='dead-letter-test' WHERE workspace_id=$1 AND job_id=$2",
    [workspaceId, jobId],
  );
  const job = {
    jobId,
    workspaceId,
    jobType: "simulate_task",
    payload: { safe: true },
    attempts: 1,
    maxAttempts: 1,
    correlationId: null,
  };
  await failJob(job, "dead-letter-test", new Error("controlled retryable failure"));
  assert.equal(
    (await getDatabasePool().query("SELECT status FROM jobs WHERE workspace_id=$1 AND job_id=$2", [workspaceId, jobId]))
      .rows[0].status,
    "dead_letter",
  );
  const commandId = randomUUID();
  await retryDeadLetter({ actor, commandId, jobId });
  const duplicate = await retryDeadLetter({ actor, commandId, jobId });
  assert.equal(duplicate.duplicate, true);
  await getDatabasePool().query(
    "UPDATE jobs SET status='completed',completed_at=now()-interval '60 days' WHERE workspace_id=$1 AND job_id=$2",
    [workspaceId, jobId],
  );
  await reviewDeadLetter({ actor, commandId: randomUUID(), jobId });
  const retention = await runRetention({ workspaceId, completedJobDays: 30, limit: 10 });
  assert.equal(retention.counts.completedJobs, 1);
});
