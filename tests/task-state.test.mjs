import assert from "node:assert/strict";
import test from "node:test";
import { createTaskEvent, rehydrateTask, transitionTask } from "../domain/task.ts";
const event = (type, version, payload) => ({
  position: version,
  eventId: crypto.randomUUID(),
  eventType: type,
  eventSchemaVersion: 1,
  aggregateType: "task",
  aggregateId: crypto.randomUUID(),
  aggregateVersion: version,
  missionId: crypto.randomUUID(),
  workspaceId: crypto.randomUUID(),
  correlationId: crypto.randomUUID(),
  actorType: "system",
  actorId: "test",
  occurredAt: new Date().toISOString(),
  payload,
  metadata: {},
});
test("task aggregate validates creation and authoritative transitions", () => {
  assert.throws(
    () =>
      createTaskEvent({
        missionId: crypto.randomUUID(),
        name: "",
        instructions: "x",
        priority: "normal",
        riskLevel: "low",
      }),
    (error) => error?.code === "validation_failed",
  );
  const created = event("task.created", 1, { missionId: crypto.randomUUID(), maximumAttempts: 1 });
  const state = rehydrateTask([created]);
  assert.equal(state.status, "pending");
  assert.equal(transitionTask(state, "ready").eventType, "task.became_ready");
  assert.throws(
    () => transitionTask(state, "completed"),
    (error) => error?.code === "invalid_transition",
  );
});
test("terminal task states reject mutation", () => {
  const created = event("task.created", 1, { missionId: crypto.randomUUID(), maximumAttempts: 1 });
  const completed = event("task.completed", 2, { status: "completed" });
  completed.aggregateId = created.aggregateId;
  const state = rehydrateTask([created, completed]);
  assert.throws(
    () => transitionTask(state, "running"),
    (error) => error?.code === "invalid_transition",
  );
});
