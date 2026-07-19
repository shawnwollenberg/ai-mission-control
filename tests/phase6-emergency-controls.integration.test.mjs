import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
const { getDatabasePool, closeDatabasePool } = await import("../lib/database.ts");
const { setEmergencyControl, emergencyControlState, assertCapabilityEnabled } =
  await import("../application/emergency-controls.ts");
const { enqueueJob, claimJob } = await import("../lib/job-store.ts");
const workspaceId = randomUUID(),
  actor = { workspaceId, userId: "phase6-owner", role: "owner" };
test.before(async () => {
  await getDatabasePool().query("INSERT INTO workspaces(id,slug,name) VALUES($1,$2,'Phase 6 controls')", [
    workspaceId,
    `phase6-${workspaceId}`,
  ]);
});
test.after(async () => {
  for (const table of ["workspace_emergency_controls", "jobs", "events", "commands", "aggregate_heads"])
    await getDatabasePool().query(`DELETE FROM ${table} WHERE workspace_id=$1`, [workspaceId]);
  await getDatabasePool().query("DELETE FROM workspaces WHERE id=$1", [workspaceId]);
  await closeDatabasePool();
});
test("owner controls are durable, audited, resumable, and worker-enforced", async () => {
  await assert.rejects(
    () =>
      setEmergencyControl({
        actor: { ...actor, role: "member" },
        control: "pause_codex_assignments",
        enabled: true,
        reason: "test",
        commandId: randomUUID(),
      }),
    /Owner role/,
  );
  const changed = await setEmergencyControl({
    actor,
    control: "pause_codex_assignments",
    enabled: true,
    reason: "incident drill",
    commandId: randomUUID(),
  });
  assert.equal((await emergencyControlState(workspaceId)).pause_codex_assignments, true);
  assert.equal(changed.events[0].eventType, "workspace.emergency_control_changed");
  await assert.rejects(() => assertCapabilityEnabled(workspaceId, "pause_codex_assignments"), /emergency control/);
  await enqueueJob({ workspaceId, jobType: "execute_codex", idempotencyKey: randomUUID() });
  assert.equal(await claimJob("codex-test", 30, workspaceId, "execute_codex"), undefined);
  await setEmergencyControl({
    actor,
    control: "pause_codex_assignments",
    enabled: false,
    reason: "drill complete",
    commandId: randomUUID(),
  });
  assert.equal((await claimJob("codex-test", 30, workspaceId, "execute_codex"))?.jobType, "execute_codex");
});
