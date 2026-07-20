import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
const { getDatabasePool, closeDatabasePool } = await import("../lib/database.ts");
const { registerRemoteAgent } = await import("../application/remote-agent-registry.ts");
const { grantAgentResource } = await import("../application/agent-eligibility.ts");
const { createTemplateVersion, launchTemplate } = await import("../application/template-commands.ts");
const { createSchedule, setScheduleEnabled, claimDueSchedule, runClaimedSchedule } =
  await import("../application/schedule-commands.ts");
const { INITIAL_TEMPLATES } = await import("../templates/initial-templates.ts");
const workspaceId = randomUUID(),
  actor = { workspaceId, userId: "owner", role: "owner" },
  healthTemplate = INITIAL_TEMPLATES.find((item) => item.definition.name === "Operational Health Report");
let templateId, resourceId;
test.before(async () => {
  await getDatabasePool().query("INSERT INTO workspaces(id,slug,name) VALUES($1,$2,'Phase 5')", [
    workspaceId,
    `phase5-${workspaceId}`,
  ]);
  const agent = await registerRemoteAgent({
    actor,
    name: "Scheduled Hermes",
    endpoint: "http://127.0.0.1:4999/executions",
    capabilities: ["metrics.read", "health.verify", "report.create"],
    supportedDomains: ["systems_monitoring"],
  });
  resourceId = randomUUID();
  await grantAgentResource({
    workspaceId,
    agentId: agent.agentId,
    resourceType: "monitoring_endpoint",
    resourceId,
    permissions: ["read"],
  });
});
test.after(async () => {
  for (const table of [
    "notification_projections",
    "schedule_run_projections",
    "schedule_projections",
    "outbox",
    "jobs",
    "task_dependencies",
    "task_projections",
    "mission_projections",
    "mission_template_projections",
    "events",
    "commands",
    "aggregate_heads",
    "agent_resource_permissions",
    "agent_credentials",
    "agents",
  ])
    await getDatabasePool().query(`DELETE FROM ${table} WHERE workspace_id=$1`, [workspaceId]);
  await getDatabasePool().query("DELETE FROM workspaces WHERE id=$1", [workspaceId]);
  await closeDatabasePool();
});

test("published templates are immutable versions and launch exact task snapshots", async () => {
  const first = await createTemplateVersion({
    actor,
    commandId: randomUUID(),
    definition: healthTemplate.definition,
    publish: true,
  });
  templateId = first.templateId;
  const second = await createTemplateVersion({
    actor,
    commandId: randomUUID(),
    templateId,
    definition: { ...healthTemplate.definition, description: "Version two draft" },
  });
  assert.equal(second.version, 2);
  await assert.rejects(
    getDatabasePool().query(
      "UPDATE mission_template_projections SET description='mutated' WHERE workspace_id=$1 AND template_id=$2 AND version=1",
      [workspaceId, templateId],
    ),
    /published template versions are immutable/,
  );
  assert.equal(
    (
      await getDatabasePool().query(
        "SELECT description FROM mission_template_projections WHERE workspace_id=$1 AND template_id=$2 AND version=1",
        [workspaceId, templateId],
      )
    ).rows[0].description,
    healthTemplate.definition.description,
  );
  await assert.rejects(
    launchTemplate({
      actor,
      commandId: randomUUID(),
      templateId,
      version: 1,
      inputs: { healthResource: randomUUID(), arbitraryPath: "/tmp" },
    }),
    /unsupported fields/,
  );
  const launched = await launchTemplate({
    actor,
    commandId: randomUUID(),
    templateId,
    version: 1,
    inputs: { healthResource: resourceId, systems: ["mission-control"] },
  });
  const mission = (
    await getDatabasePool().query(
      "SELECT template_id,template_version,resolved_inputs,resolved_task_plan FROM mission_projections WHERE workspace_id=$1 AND mission_id=$2",
      [workspaceId, launched.missionId],
    )
  ).rows[0];
  assert.equal(mission.template_id, templateId);
  assert.equal(mission.template_version, 1);
  assert.equal(mission.resolved_inputs.healthResource, resourceId);
  assert.equal(mission.resolved_task_plan.length, 1);
});

test("recurring schedules persist their rule and advance after a run", async () => {
  const schedule = await createSchedule({
    actor,
    commandId: randomUUID(),
    name: "Hourly health",
    templateId,
    templateVersion: 1,
    inputs: { healthResource: resourceId },
    timeZone: "America/New_York",
    rule: { type: "hourly" },
    startAt: new Date(Date.now() - 1000).toISOString(),
    concurrencyPolicy: "allow_parallel",
    missedRunPolicy: "run_once_on_recovery",
  });
  const claimed = await claimDueSchedule("scheduler-recurring", 30, workspaceId);
  assert.equal(claimed.schedule_id, schedule.scheduleId);
  await runClaimedSchedule(claimed, "scheduler-recurring");
  const persisted = (
    await getDatabasePool().query(
      "SELECT schedule_rule,next_run_at FROM schedule_projections WHERE workspace_id=$1 AND schedule_id=$2",
      [workspaceId, schedule.scheduleId],
    )
  ).rows[0];
  assert.equal(persisted.schedule_rule.type, "hourly");
  assert.ok(new Date(persisted.next_run_at) > new Date(claimed.next_run_at));
});

test("leased scheduler creates one mission and notification under duplicate workers and restart", async () => {
  const schedule = await createSchedule({
    actor,
    commandId: randomUUID(),
    name: "Daily health",
    templateId,
    templateVersion: 1,
    inputs: { healthResource: resourceId },
    timeZone: "America/New_York",
    rule: { type: "once", at: new Date(Date.now() - 1000).toISOString() },
    startAt: new Date(Date.now() - 1000).toISOString(),
    concurrencyPolicy: "skip_if_running",
    missedRunPolicy: "run_once_on_recovery",
  });
  const [one, two] = await Promise.all([
    claimDueSchedule("scheduler-a", 30, workspaceId),
    claimDueSchedule("scheduler-b", 30, workspaceId),
  ]);
  assert.equal([one, two].filter(Boolean).length, 1);
  const claimed = one ?? two;
  const worker = one ? "scheduler-a" : "scheduler-b";
  const result = await runClaimedSchedule(claimed, worker);
  assert.equal(result.status, "created");
  assert.equal((await runClaimedSchedule(claimed, worker)).duplicate, true);
  assert.equal(
    (
      await getDatabasePool().query(
        "SELECT count(*)::int total FROM mission_projections WHERE workspace_id=$1 AND origin_schedule_id=$2",
        [workspaceId, schedule.scheduleId],
      )
    ).rows[0].total,
    1,
  );
  assert.equal(
    (
      await getDatabasePool().query(
        "SELECT count(*)::int total FROM notification_projections WHERE workspace_id=$1 AND schedule_id=$2",
        [workspaceId, schedule.scheduleId],
      )
    ).rows[0].total,
    1,
  );
  await setScheduleEnabled({ actor, commandId: randomUUID(), scheduleId: schedule.scheduleId, enabled: false });
  assert.equal(await claimDueSchedule("scheduler-c", 30, workspaceId), undefined);
});
