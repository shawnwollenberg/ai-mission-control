import assert from "node:assert/strict";
import test from "node:test";
import { orchestrateAcceptanceFinalization } from "../lib/acceptance-finalization-orchestrator.ts";

const evidence = (checkpoint) => ({ checkpoint, result: "pass", binding_hash: checkpoint });

test("finalization checkpoints surround the actual review and cleanup actions in exact order", async () => {
  const order = [];
  const result = await orchestrateAcceptanceFinalization({
    checkpoint: (phase) => {
      order.push(`checkpoint:${phase}`);
      return evidence(phase);
    },
    persistCheckpoint: (item) => {
      order.push(`persist:${item.checkpoint}`);
    },
    runIndependentReview: async () => {
      order.push("action:review");
      return { ok: true };
    },
    validateIndependentReview: () => {
      order.push("validate:review");
    },
    runCleanup: async () => {
      order.push("action:cleanup");
      return { ok: true };
    },
    validateCleanup: () => {
      order.push("validate:cleanup");
    },
  });
  assert.deepEqual(order, [
    "checkpoint:before_independent_review",
    "persist:before_independent_review",
    "action:review",
    "validate:review",
    "checkpoint:before_final_cleanup",
    "persist:before_final_cleanup",
    "action:cleanup",
    "validate:cleanup",
    "checkpoint:after_final_cleanup",
    "persist:after_final_cleanup",
  ]);
  assert.equal(result.afterCleanup.checkpoint, "after_final_cleanup");
});

for (const failingPhase of ["before_independent_review", "before_final_cleanup", "after_final_cleanup"]) {
  test(`source mutation at ${failingPhase} prevents final acceptance`, async () => {
    const actions = [];
    await assert.rejects(
      () =>
        orchestrateAcceptanceFinalization({
          checkpoint: (phase) => {
            if (phase === failingPhase) throw new Error(`source changed:${phase}`);
            return evidence(phase);
          },
          persistCheckpoint: () => undefined,
          runIndependentReview: async () => {
            actions.push("review");
            return {};
          },
          validateIndependentReview: () => undefined,
          runCleanup: async () => {
            actions.push("cleanup");
            return {};
          },
          validateCleanup: () => undefined,
        }),
      new RegExp(`source changed:${failingPhase}`),
    );
    if (failingPhase === "before_independent_review") assert.deepEqual(actions, ["cleanup"]);
    if (failingPhase === "before_final_cleanup") assert.deepEqual(actions, ["review", "cleanup"]);
    if (failingPhase === "after_final_cleanup") assert.deepEqual(actions, ["review", "cleanup"]);
  });
}

test("review failure remains authoritative when cleanup also fails", async () => {
  const primary = new Error("review failed");
  await assert.rejects(
    () =>
      orchestrateAcceptanceFinalization({
        checkpoint: (phase) => evidence(phase),
        persistCheckpoint: () => undefined,
        runIndependentReview: async () => {
          throw primary;
        },
        validateIndependentReview: () => undefined,
        runCleanup: async () => {
          throw new Error("cleanup failed");
        },
        validateCleanup: () => undefined,
      }),
    (error) => error === primary && error.cleanupError?.message === "cleanup failed",
  );
});
