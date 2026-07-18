import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");

const { handleCreateMission, handleMissionTransition } = await import("../application/mission-commands.ts");
const { InvalidTransitionError } = await import("../lib/application-errors.ts");
const { closeDatabasePool, getDatabasePool } = await import("../lib/database.ts");
const { getMissionProjection } = await import("../lib/mission-projection-store.ts");
const { loadAggregateEvents } = await import("../lib/postgres-event-store.ts");

const workspaceId = randomUUID();
const actor = { workspaceId, userId: "mission-owner", role: "owner" };

test.before(async () => {
  await getDatabasePool().query("INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'Mission Commands')", [
    workspaceId,
    `mission-commands-${workspaceId}`,
  ]);
});

test.after(async () => {
  await getDatabasePool().query("DELETE FROM mission_projections WHERE workspace_id = $1", [workspaceId]);
  await getDatabasePool().query("DELETE FROM events WHERE workspace_id = $1", [workspaceId]);
  await getDatabasePool().query("DELETE FROM commands WHERE workspace_id = $1", [workspaceId]);
  await getDatabasePool().query("DELETE FROM aggregate_heads WHERE workspace_id = $1", [workspaceId]);
  await getDatabasePool().query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
  await closeDatabasePool();
});

function create(commandId = randomUUID()) {
  return handleCreateMission({
    actor,
    commandId,
    mission: {
      name: "Durable release",
      objective: "Ship a durable release",
      domain: "software_delivery",
      priority: "high",
      riskLevel: "unknown",
    },
  });
}

test("mission creation writes the event and transactional projection", async () => {
  const result = await create();
  assert.equal(result.status, "draft");
  const projection = await getMissionProjection(workspaceId, result.missionId);
  assert.equal(projection?.objective, "Ship a durable release");
  assert.equal(projection?.status, "draft");
  assert.equal(projection?.aggregateVersion, 1);
  assert.ok(projection?.lastEventPosition);
});

test("valid lifecycle transitions update events and projection", async () => {
  const created = await create();
  for (const target of ["planned", "running", "paused", "running", "completed"]) {
    await handleMissionTransition({ actor, commandId: randomUUID(), missionId: created.missionId, target });
  }
  const projection = await getMissionProjection(workspaceId, created.missionId);
  assert.equal(projection?.status, "completed");
  assert.equal(projection?.aggregateVersion, 6);
});

test("invalid and terminal transitions append nothing", async () => {
  const created = await create();
  await assert.rejects(
    () =>
      handleMissionTransition({ actor, commandId: randomUUID(), missionId: created.missionId, target: "completed" }),
    InvalidTransitionError,
  );
  await handleMissionTransition({ actor, commandId: randomUUID(), missionId: created.missionId, target: "cancelled" });
  await assert.rejects(
    () => handleMissionTransition({ actor, commandId: randomUUID(), missionId: created.missionId, target: "running" }),
    InvalidTransitionError,
  );
  assert.equal(
    (await loadAggregateEvents({ workspaceId, aggregateType: "mission", aggregateId: created.missionId })).length,
    2,
  );
});

test("repeated state commands are explicit no-op successes", async () => {
  const created = await create();
  await handleMissionTransition({ actor, commandId: randomUUID(), missionId: created.missionId, target: "planned" });
  const repeated = await handleMissionTransition({
    actor,
    commandId: randomUUID(),
    missionId: created.missionId,
    target: "planned",
  });
  assert.equal(repeated.alreadyInState, true);
  assert.equal(repeated.eventIds.length, 0);
});

test("workspace-scoped projection queries cannot read another workspace mission", async () => {
  const created = await create();
  assert.equal(await getMissionProjection(randomUUID(), created.missionId), undefined);
});
