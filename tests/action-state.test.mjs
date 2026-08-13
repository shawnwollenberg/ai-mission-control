import assert from "node:assert/strict";
import test from "node:test";
import { reconcileFailedActionExecution } from "../domain/action-request.ts";

test("only a failed action can enter exact-effect reconciliation", () => {
  const failed = {
    id: crypto.randomUUID(),
    missionId: crypto.randomUUID(),
    status: "failed",
    version: 7,
    actionType: "repository.publish_for_review",
    actionHash: "bound-hash",
  };
  assert.deepEqual(reconcileFailedActionExecution(failed), {
    eventType: "action.execution_reconciliation_started",
    eventSchemaVersion: 1,
    payload: { status: "executing", reconciliation: true },
  });
  assert.throws(
    () => reconcileFailedActionExecution({ ...failed, status: "succeeded" }),
    (error) => error?.code === "invalid_transition",
  );
});
