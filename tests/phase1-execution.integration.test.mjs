import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
const { handleCreateMission, handleMissionTransition } = await import("../application/mission-commands.ts");
const { handleCreateTask, handleAddTaskDependency, handleTaskTransition } =
  await import("../application/task-commands.ts");
const { runSimulationJob, resolveApproval } = await import("../application/simulated-executor.ts");
const { enqueueJob, claimJob, completeJob } = await import("../lib/job-store.ts");
const { getDatabasePool, closeDatabasePool } = await import("../lib/database.ts");
const { ValidationFailedError } = await import("../lib/application-errors.ts");
const workspaceId = randomUUID();
const human = { workspaceId, userId: "owner", role: "owner" };
const actor = { workspaceId, id: "owner", type: "human" };
test.before(async () => {
  await getDatabasePool().query("INSERT INTO workspaces(id,slug,name) VALUES($1,$2,'Phase 1 Execution')", [
    workspaceId,
    `phase1-${workspaceId}`,
  ]);
});
test.after(async () => {
  await getDatabasePool().query("DELETE FROM outbox WHERE workspace_id=$1", [workspaceId]);
  await getDatabasePool().query("DELETE FROM dead_letters WHERE workspace_id=$1", [workspaceId]);
  await getDatabasePool().query("DELETE FROM jobs WHERE workspace_id=$1", [workspaceId]);
  await getDatabasePool().query("DELETE FROM approval_projections WHERE workspace_id=$1", [workspaceId]);
  await getDatabasePool().query("DELETE FROM mission_projections WHERE workspace_id=$1", [workspaceId]);
  await getDatabasePool().query("DELETE FROM events WHERE workspace_id=$1", [workspaceId]);
  await getDatabasePool().query("DELETE FROM commands WHERE workspace_id=$1", [workspaceId]);
  await getDatabasePool().query("DELETE FROM aggregate_heads WHERE workspace_id=$1", [workspaceId]);
  await getDatabasePool().query("DELETE FROM workspaces WHERE id=$1", [workspaceId]);
  await closeDatabasePool();
});
async function mission() {
  return handleCreateMission({
    actor: human,
    commandId: randomUUID(),
    mission: {
      name: "ServicePilot Stripe Production Readiness",
      objective: "Validate Stripe production readiness",
      domain: "software_delivery",
      priority: "high",
      riskLevel: "moderate",
    },
  });
}
async function task(missionId, name, approval = false) {
  return handleCreateTask({
    actor,
    commandId: randomUUID(),
    task: {
      missionId,
      name,
      instructions: `Perform ${name}`,
      priority: "normal",
      riskLevel: approval ? "high" : "low",
      maximumAttempts: 2,
      approvalPolicy: { required: approval },
    },
  });
}
test("dependencies are durable, idempotent, cycle-safe, and activate from mission start", async () => {
  const m = await mission();
  const a = await task(m.missionId, "upstream");
  const b = await task(m.missionId, "downstream");
  await handleAddTaskDependency({ actor, commandId: randomUUID(), taskId: b.taskId, dependsOnTaskId: a.taskId });
  const duplicate = await handleAddTaskDependency({
    actor,
    commandId: randomUUID(),
    taskId: b.taskId,
    dependsOnTaskId: a.taskId,
  });
  assert.equal(duplicate.alreadyInState, true);
  await assert.rejects(
    () => handleAddTaskDependency({ actor, commandId: randomUUID(), taskId: a.taskId, dependsOnTaskId: a.taskId }),
    ValidationFailedError,
  );
  await assert.rejects(
    () => handleAddTaskDependency({ actor, commandId: randomUUID(), taskId: a.taskId, dependsOnTaskId: b.taskId }),
    ValidationFailedError,
  );
  await handleMissionTransition({ actor: human, commandId: randomUUID(), missionId: m.missionId, target: "planned" });
  await handleMissionTransition({ actor: human, commandId: randomUUID(), missionId: m.missionId, target: "running" });
  const states = await getDatabasePool().query(
    "SELECT name,status FROM task_projections WHERE workspace_id=$1 AND mission_id=$2 ORDER BY name",
    [workspaceId, m.missionId],
  );
  assert.deepEqual(Object.fromEntries(states.rows.map((r) => [r.name, r.status])), {
    downstream: "blocked",
    upstream: "ready",
  });
});
test("durable simulated execution stops for approval and completes after grant", async () => {
  const m = await mission();
  const first = await task(m.missionId, "Inspect architecture");
  const gated = await task(m.missionId, "Validate risk", true);
  await handleAddTaskDependency({
    actor,
    commandId: randomUUID(),
    taskId: gated.taskId,
    dependsOnTaskId: first.taskId,
  });
  await handleMissionTransition({ actor: human, commandId: randomUUID(), missionId: m.missionId, target: "planned" });
  await handleMissionTransition({ actor: human, commandId: randomUUID(), missionId: m.missionId, target: "running" });
  await runSimulationJob({
    jobId: randomUUID(),
    workspaceId,
    jobType: "simulate_task",
    payload: { missionId: m.missionId, taskId: first.taskId },
    attempts: 1,
    maxAttempts: 5,
    correlationId: m.missionId,
  });
  await runSimulationJob({
    jobId: randomUUID(),
    workspaceId,
    jobType: "simulate_task",
    payload: { missionId: m.missionId, taskId: gated.taskId },
    attempts: 1,
    maxAttempts: 5,
    correlationId: m.missionId,
  });
  const approval = (
    await getDatabasePool().query(
      "SELECT approval_id,status FROM approval_projections WHERE workspace_id=$1 AND mission_id=$2",
      [workspaceId, m.missionId],
    )
  ).rows[0];
  assert.equal(approval.status, "pending");
  assert.equal(
    (
      await getDatabasePool().query("SELECT status FROM task_projections WHERE workspace_id=$1 AND task_id=$2", [
        workspaceId,
        gated.taskId,
      ])
    ).rows[0].status,
    "waiting_for_approval",
  );
  await resolveApproval({
    workspaceId,
    approvalId: approval.approval_id,
    granted: true,
    decidedBy: "owner",
    reason: "Evidence accepted",
  });
  assert.equal(
    (
      await getDatabasePool().query("SELECT status FROM mission_projections WHERE workspace_id=$1 AND mission_id=$2", [
        workspaceId,
        m.missionId,
      ])
    ).rows[0].status,
    "completed",
  );
});
test("failed required dependency leaves downstream blocked and fails mission", async () => {
  const m = await mission();
  const upstream = await task(m.missionId, "Required work");
  const downstream = await task(m.missionId, "Dependent work");
  await handleAddTaskDependency({
    actor,
    commandId: randomUUID(),
    taskId: downstream.taskId,
    dependsOnTaskId: upstream.taskId,
  });
  await handleMissionTransition({ actor: human, commandId: randomUUID(), missionId: m.missionId, target: "planned" });
  await handleMissionTransition({ actor: human, commandId: randomUUID(), missionId: m.missionId, target: "running" });
  await handleTaskTransition({ actor, commandId: randomUUID(), taskId: upstream.taskId, target: "assigned" });
  await handleTaskTransition({ actor, commandId: randomUUID(), taskId: upstream.taskId, target: "running" });
  await handleTaskTransition({
    actor,
    commandId: randomUUID(),
    taskId: upstream.taskId,
    target: "failed",
    details: { reason: "unrecoverable" },
  });
  const { coordinateAfterTask } = await import("../application/mission-coordinator.ts");
  await coordinateAfterTask(workspaceId, m.missionId, upstream.taskId, "task.failed");
  assert.equal(
    (
      await getDatabasePool().query("SELECT status FROM task_projections WHERE workspace_id=$1 AND task_id=$2", [
        workspaceId,
        downstream.taskId,
      ])
    ).rows[0].status,
    "blocked",
  );
  assert.equal(
    (
      await getDatabasePool().query("SELECT status FROM mission_projections WHERE workspace_id=$1 AND mission_id=$2", [
        workspaceId,
        m.missionId,
      ])
    ).rows[0].status,
    "failed",
  );
});
test("leased jobs use skip-locked claims and recover stale locks", async () => {
  await getDatabasePool().query("DELETE FROM jobs WHERE workspace_id=$1", [workspaceId]);
  const jobId = await enqueueJob({ workspaceId, jobType: "simulate_task", payload: {}, idempotencyKey: randomUUID() });
  const [a, b] = await Promise.all([claimJob("worker-a", 30, workspaceId), claimJob("worker-b", 30, workspaceId)]);
  const claimed = [a, b].filter((j) => j?.jobId === jobId);
  assert.equal(claimed.length, 1);
  await completeJob(jobId, claimed[0] === a ? "worker-a" : "worker-b");
  const stale = await enqueueJob({ workspaceId, jobType: "simulate_task", payload: {}, idempotencyKey: randomUUID() });
  await getDatabasePool().query(
    "UPDATE jobs SET status='processing',lease_owner='dead-worker',lease_expires_at=now()-interval '1 second' WHERE job_id=$1",
    [stale],
  );
  let recovered;
  for (let i = 0; i < 5; i++) {
    const candidate = await claimJob("recovery-worker", 30, workspaceId);
    if (candidate?.jobId === stale) {
      recovered = candidate;
      break;
    }
    if (candidate) await completeJob(candidate.jobId, "recovery-worker");
  }
  assert.equal(recovered?.jobId, stale);
});
