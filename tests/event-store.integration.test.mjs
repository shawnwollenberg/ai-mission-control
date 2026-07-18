import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");

const { ConcurrencyConflictError, ValidationFailedError } = await import("../lib/application-errors.ts");
const { closeDatabasePool, getDatabasePool } = await import("../lib/database.ts");
const { appendEvents, loadAggregateEvents, loadEventsFromGlobalPosition, loadMissionEvents } =
  await import("../lib/postgres-event-store.ts");

const workspaceA = randomUUID();
const workspaceB = randomUUID();

test.before(async () => {
  await getDatabasePool().query(
    "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'Event Store A'), ($3, $4, 'Event Store B')",
    [workspaceA, `events-a-${workspaceA}`, workspaceB, `events-b-${workspaceB}`],
  );
});

test.after(async () => {
  const workspaceIds = [workspaceA, workspaceB];
  await getDatabasePool().query("DELETE FROM outbox WHERE workspace_id = ANY($1::uuid[])", [workspaceIds]);
  await getDatabasePool().query("DELETE FROM events WHERE workspace_id = ANY($1::uuid[])", [workspaceIds]);
  await getDatabasePool().query("DELETE FROM commands WHERE workspace_id = ANY($1::uuid[])", [workspaceIds]);
  await getDatabasePool().query("DELETE FROM aggregate_heads WHERE workspace_id = ANY($1::uuid[])", [workspaceIds]);
  await getDatabasePool().query("DELETE FROM workspaces WHERE id = ANY($1::uuid[])", [workspaceIds]);
  await closeDatabasePool();
});

function input(overrides = {}) {
  const aggregateId = overrides.aggregateId ?? randomUUID();
  return {
    workspaceId: workspaceA,
    aggregateType: "mission",
    aggregateId,
    missionId: aggregateId,
    expectedVersion: 0,
    commandId: randomUUID(),
    commandType: "CreateMission",
    correlationId: randomUUID(),
    actor: { type: "human", id: "integration-owner" },
    events: [{ eventType: "mission.created", eventSchemaVersion: 1, payload: { objective: "Durable mission" } }],
    ...overrides,
  };
}

test("events append with aggregate versions and globally ordered positions", async () => {
  const aggregateId = randomUUID();
  const first = await appendEvents(
    input({
      aggregateId,
      events: [
        { eventType: "mission.created", eventSchemaVersion: 1, payload: { objective: "Ordered" } },
        { eventType: "mission.planned", eventSchemaVersion: 1, payload: {} },
      ],
    }),
  );
  assert.deepEqual(
    first.events.map((event) => event.aggregateVersion),
    [1, 2],
  );
  assert.ok(first.events[0].position < first.events[1].position);
  assert.deepEqual(
    (await loadAggregateEvents({ workspaceId: workspaceA, aggregateType: "mission", aggregateId })).map(
      (event) => event.eventType,
    ),
    ["mission.created", "mission.planned"],
  );
});

test("an incorrect expected version produces an explicit concurrency conflict", async () => {
  const aggregateId = randomUUID();
  await appendEvents(input({ aggregateId }));
  await assert.rejects(() => appendEvents(input({ aggregateId, expectedVersion: 0 })), ConcurrencyConflictError);
  assert.equal(
    (await loadAggregateEvents({ workspaceId: workspaceA, aggregateType: "mission", aggregateId })).length,
    1,
  );
});

test("concurrent appends at one expected version yield one success and one conflict", async () => {
  const aggregateId = randomUUID();
  await appendEvents(input({ aggregateId }));
  const attempts = await Promise.allSettled([
    appendEvents(
      input({
        aggregateId,
        expectedVersion: 1,
        commandType: "PlanMission",
        events: [{ eventType: "mission.planned", eventSchemaVersion: 1, payload: {} }],
      }),
    ),
    appendEvents(
      input({
        aggregateId,
        expectedVersion: 1,
        commandType: "CancelMission",
        events: [{ eventType: "mission.cancelled", eventSchemaVersion: 1, payload: {} }],
      }),
    ),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  const rejected = attempts.find((attempt) => attempt.status === "rejected");
  assert.ok(rejected && rejected.reason instanceof ConcurrencyConflictError);
  assert.equal(
    (await loadAggregateEvents({ workspaceId: workspaceA, aggregateType: "mission", aggregateId })).length,
    2,
  );
});

test("duplicate command IDs return the original result without duplicating events or outbox", async () => {
  const aggregateId = randomUUID();
  const commandId = randomUUID();
  const appendInput = input({
    aggregateId,
    commandId,
    outbox: [{ eventIndex: 0, topic: "projection.test", idempotencyKey: commandId, payload: { aggregateId } }],
  });
  const first = await appendEvents(appendInput);
  const duplicate = await appendEvents(appendInput);
  assert.equal(first.duplicateCommand, false);
  assert.equal(duplicate.duplicateCommand, true);
  assert.equal(duplicate.events[0].eventId, first.events[0].eventId);
  const counts = await getDatabasePool().query(
    "SELECT (SELECT count(*) FROM events WHERE aggregate_id = $1) events, (SELECT count(*) FROM outbox WHERE idempotency_key = $2) outbox",
    [aggregateId, commandId],
  );
  assert.equal(Number(counts.rows[0].events), 1);
  assert.equal(Number(counts.rows[0].outbox), 1);
});

test("invalid multi-event append is atomic and leaves no command or aggregate head", async () => {
  const aggregateId = randomUUID();
  const commandId = randomUUID();
  await assert.rejects(
    () =>
      appendEvents(
        input({
          aggregateId,
          commandId,
          events: [
            { eventType: "mission.created", eventSchemaVersion: 1, payload: {} },
            { eventType: "mission.invalid", eventSchemaVersion: 0, payload: {} },
          ],
        }),
      ),
    ValidationFailedError,
  );
  const counts = await getDatabasePool().query(
    `SELECT
       (SELECT count(*) FROM events WHERE aggregate_id = $1) events,
       (SELECT count(*) FROM commands WHERE command_id = $2) commands,
       (SELECT count(*) FROM aggregate_heads WHERE aggregate_id = $1) heads`,
    [aggregateId, commandId],
  );
  assert.deepEqual(
    [Number(counts.rows[0].events), Number(counts.rows[0].commands), Number(counts.rows[0].heads)],
    [0, 0, 0],
  );
});

test("projection failure rolls back events, aggregate state, command, and outbox together", async () => {
  const aggregateId = randomUUID();
  const commandId = randomUUID();
  await assert.rejects(() =>
    appendEvents(
      input({
        aggregateId,
        commandId,
        outbox: [{ eventIndex: 0, topic: "projection.test", idempotencyKey: commandId, payload: {} }],
        applyProjections: async () => {
          throw new Error("intentional projector failure");
        },
      }),
    ),
  );
  const counts = await getDatabasePool().query(
    `SELECT
       (SELECT count(*) FROM events WHERE aggregate_id = $1) events,
       (SELECT count(*) FROM commands WHERE command_id = $2) commands,
       (SELECT count(*) FROM aggregate_heads WHERE aggregate_id = $1) heads,
       (SELECT count(*) FROM outbox WHERE idempotency_key = $2::text) outbox`,
    [aggregateId, commandId],
  );
  assert.deepEqual(
    [
      Number(counts.rows[0].events),
      Number(counts.rows[0].commands),
      Number(counts.rows[0].heads),
      Number(counts.rows[0].outbox),
    ],
    [0, 0, 0, 0],
  );
});

test("workspace reads isolate aggregate, mission, and global event streams", async () => {
  const aggregateId = randomUUID();
  await appendEvents(input({ workspaceId: workspaceA, aggregateId }));
  assert.equal((await loadMissionEvents({ workspaceId: workspaceA, missionId: aggregateId })).length, 1);
  assert.equal((await loadMissionEvents({ workspaceId: workspaceB, missionId: aggregateId })).length, 0);
  assert.equal(
    (await loadEventsFromGlobalPosition({ workspaceId: workspaceB, afterPosition: 0 })).some(
      (event) => event.aggregateId === aggregateId,
    ),
    false,
  );
});
