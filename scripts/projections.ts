import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { closeDatabasePool, getDatabasePool, withTransaction } from "../lib/database";
import { loadEventsFromGlobalPosition, type DomainEvent } from "../lib/postgres-event-store";
import { applyMissionProjection } from "../application/mission-projector";
import { applyTaskProjection } from "../application/task-projector";
import { applyApprovalProjection } from "../application/approval-commands";
import { applyExecutionProjection } from "../application/execution-projector";
import { applyActionProjection } from "../application/action-projector";
import { applyTemplateProjection } from "../application/template-projector";
import { applyScheduleProjection } from "../application/schedule-projector";
import { applyNotificationProjection } from "../application/notification-projector";
import { applyNotificationPreferenceProjection } from "../application/notification-preferences";
import { applyUsageProjection, applyBudgetProjection } from "../application/usage-budget";
import { applyWorkerProjection } from "../application/worker-operations";
import { applySavedViewProjection } from "../application/mission-search";
import { applyAnomalyProjection } from "../application/anomaly-operations";
import { applyEmergencyControlProjection } from "../application/emergency-controls";
import { applyRecommendationProjection } from "../application/recommendation-projector";
import { applyRepositoryHealthProjection } from "../application/repository-health-projector";
const args = process.argv.slice(2);
const value = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const workspace = value("--workspace");
const projection = value("--projection") ?? "all";
const verify = args.includes("--verify");
async function events() {
  if (workspace) {
    const all: DomainEvent[] = [];
    let position = 0;
    while (true) {
      const page = await loadEventsFromGlobalPosition({ workspaceId: workspace, afterPosition: position, limit: 2000 });
      all.push(...page);
      if (page.length < 2000) break;
      position = page.at(-1)!.position;
    }
    return all;
  }
  const workspaces = await getDatabasePool().query<{ workspace_id: string }>(
    "SELECT DISTINCT workspace_id FROM events",
  );
  const all = (await Promise.all(workspaces.rows.map((r) => loadWorkspace(r.workspace_id)))).flat();
  return all.sort((a, b) => a.position - b.position);
}
async function loadWorkspace(id: string) {
  const all: DomainEvent[] = [];
  let p = 0;
  while (true) {
    const page = await loadEventsFromGlobalPosition({ workspaceId: id, afterPosition: p, limit: 2000 });
    all.push(...page);
    if (page.length < 2000) return all;
    p = page.at(-1)!.position;
  }
}
async function snapshot(client: PoolClient) {
  const where = workspace ? " WHERE workspace_id=$1" : "";
  const params = workspace ? [workspace] : [];
  const tables: Record<string, { order: string; jsonExpression?: string }> = {
    mission_projections: { order: "1,2" },
    task_projections: { order: "1,2" },
    task_dependencies: { order: "1,2,3,4" },
    approval_projections: { order: "1,2" },
    // last_heartbeat_at is transient transport liveness updated outside the event
    // stream. All authoritative execution fields remain replay-verified.
    execution_projections: { order: "1,2", jsonExpression: "to_jsonb(x) - 'last_heartbeat_at'" },
    action_request_projections: { order: "1,2" },
    mission_template_projections: { order: "1,2,3" },
    schedule_projections: { order: "1,2" },
    schedule_run_projections: { order: "1,2" },
    notification_projections: { order: "1,2" },
    notification_preferences: { order: "1" },
    usage_records: { order: "1,2" },
    budget_policies: { order: "1,2" },
    budget_decisions: { order: "1,2" },
    worker_projections: { order: "1,2" },
    saved_view_projections: { order: "1,2" },
    anomaly_projections: { order: "1,2" },
    workspace_emergency_controls: { order: "1" },
    recommendation_projections: { order: "1,2" },
    repository_health_assessments: { order: "1,2" },
  };
  const out: Record<string, unknown> = {};
  for (const [table, definition] of Object.entries(tables))
    out[table] = (
      await client.query(
        `SELECT ${definition.jsonExpression ?? "row_to_json(x)"} value FROM (SELECT * FROM ${table}${where} ORDER BY ${definition.order}) x`,
        params,
      )
    ).rows.map((r) => r.value);
  return out;
}
async function replay(client: PoolClient, stream: DomainEvent[]) {
  const suffix = workspace ? " WHERE workspace_id=$1" : "";
  const params = workspace ? [workspace] : [];
  await client.query(`DELETE FROM approval_projections${suffix}`, params);
  await client.query(`DELETE FROM recommendation_projections${suffix}`, params);
  await client.query(`DELETE FROM repository_health_assessments${suffix}`, params);
  await client.query(`DELETE FROM action_request_projections${suffix}`, params);
  await client.query(`DELETE FROM execution_projections${suffix}`, params);
  await client.query(`DELETE FROM notification_projections${suffix}`, params);
  await client.query(`DELETE FROM notification_preferences${suffix}`, params);
  await client.query(`DELETE FROM budget_decisions${suffix}`, params);
  await client.query(`DELETE FROM budget_policies${suffix}`, params);
  await client.query(`DELETE FROM usage_records${suffix}`, params);
  await client.query(`DELETE FROM worker_projections${suffix}`, params);
  await client.query(`DELETE FROM saved_view_projections${suffix}`, params);
  await client.query(`DELETE FROM anomaly_projections${suffix}`, params);
  await client.query(`DELETE FROM workspace_emergency_controls${suffix}`, params);
  await client.query(`DELETE FROM schedule_run_projections${suffix}`, params);
  await client.query(`DELETE FROM schedule_projections${suffix}`, params);
  await client.query(`DELETE FROM mission_template_projections${suffix}`, params);
  await client.query(`DELETE FROM task_projections${suffix}`, params);
  await client.query(`DELETE FROM mission_projections${suffix}`, params);
  for (const event of stream) {
    if (event.eventSchemaVersion !== 1)
      throw new Error(
        `Unsupported event version ${event.eventSchemaVersion} for ${event.eventType} at position ${event.position}`,
      );
    if (event.aggregateType === "mission") await applyMissionProjection(client, [event]);
    else if (event.aggregateType === "task") await applyTaskProjection(client, [event]);
    else if (event.aggregateType === "approval") await applyApprovalProjection(client, [event]);
    else if (event.aggregateType === "execution") await applyExecutionProjection(client, [event]);
    else if (event.aggregateType === "action_request") await applyActionProjection(client, [event]);
    else if (event.aggregateType === "mission_template") await applyTemplateProjection(client, [event]);
    else if (event.aggregateType === "schedule") await applyScheduleProjection(client, [event]);
    else if (event.aggregateType === "notification") await applyNotificationProjection(client, [event]);
    else if (event.aggregateType === "notification_preferences")
      await applyNotificationPreferenceProjection(client, [event]);
    else if (event.aggregateType === "usage") await applyUsageProjection(client, [event]);
    else if (["budget_policy", "budget_decision"].includes(event.aggregateType))
      await applyBudgetProjection(client, [event]);
    else if (event.aggregateType === "worker") await applyWorkerProjection(client, [event]);
    else if (event.aggregateType === "saved_view") await applySavedViewProjection(client, [event]);
    else if (event.aggregateType === "anomaly") await applyAnomalyProjection(client, [event]);
    else if (event.aggregateType === "workspace_emergency_controls")
      await applyEmergencyControlProjection(client, [event]);
    else if (event.aggregateType === "recommendation") await applyRecommendationProjection(client, [event]);
    else if (event.aggregateType === "repository_health") await applyRepositoryHealthProjection(client, [event]);
  }
}
async function main() {
  if (!["all", "missions", "tasks", "approvals"].includes(projection))
    throw new Error(`Unknown projection ${projection}`);
  const stream = await events();
  if (verify) {
    let before: Record<string, unknown> = {},
      after: Record<string, unknown> = {};
    try {
      await withTransaction(async (client) => {
        const locked = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock($1) ok", [1_296_743_202]);
        if (!locked.rows[0].ok) throw new Error("A projection rebuild is already running");
        before = await snapshot(client);
        await replay(client, stream);
        after = await snapshot(client);
        throw new Error("__ROLLBACK_VERIFY__");
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "__ROLLBACK_VERIFY__") throw error;
    }
    const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const discrepancies = Object.keys(before).flatMap((table) =>
      hash(before[table]) === hash(after[table])
        ? []
        : [
            {
              table,
              liveHash: hash(before[table]),
              replayHash: hash(after[table]),
              liveRows: (before[table] as unknown[]).length,
              replayRows: (after[table] as unknown[]).length,
            },
          ],
    );
    const equal = discrepancies.length === 0;
    console.log(
      JSON.stringify({
        event: "projection_verification",
        workspace: workspace ?? "all",
        projection,
        equal,
        eventCount: stream.length,
        discrepancies,
      }),
    );
    if (!equal) process.exitCode = 2;
    return;
  }
  const rebuildId = randomUUID();
  await getDatabasePool().query(
    "INSERT INTO projection_rebuild_runs(rebuild_id,workspace_id,projection,status) VALUES($1,$2,$3,'running')",
    [rebuildId, workspace ?? null, projection],
  );
  try {
    await withTransaction(async (client) => {
      const locked = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock($1) ok", [1_296_743_202]);
      if (!locked.rows[0].ok) throw new Error("A projection rebuild is already running");
      await replay(client, stream);
      await client.query(
        "UPDATE projection_rebuild_runs SET status='complete',last_position=$2,event_count=$3,completed_at=now() WHERE rebuild_id=$1",
        [rebuildId, stream.at(-1)?.position ?? 0, stream.length],
      );
    });
    console.log(
      JSON.stringify({
        event: "projection_rebuild_complete",
        rebuildId,
        workspace: workspace ?? "all",
        projection,
        eventCount: stream.length,
      }),
    );
  } catch (error) {
    await getDatabasePool().query(
      "UPDATE projection_rebuild_runs SET status='failed',failure=$2,completed_at=now() WHERE rebuild_id=$1",
      [rebuildId, { message: error instanceof Error ? error.message : String(error) }],
    );
    throw error;
  }
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDatabasePool);
