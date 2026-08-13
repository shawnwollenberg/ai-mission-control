import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertExecutionTerminalEvidenceBarrier,
  assertGovernedExecutionObservation,
  assertWorkspaceExecutionQuiescence,
  observeGovernedExecutionTerminal,
} from "../lib/acceptance-execution-observer.ts";

const base = Object.freeze({
  workspaceId: "00000000-0000-4000-8000-000000000001",
  missionId: "00000000-0000-4000-8000-000000000002",
  childMissionId: "00000000-0000-4000-8000-000000000003",
  executionId: "00000000-0000-4000-8000-000000000004",
  assignmentId: "00000000-0000-4000-8000-000000000005",
  assignmentAttempt: 1,
  leaseReceiptId: "00000000-0000-4000-8000-000000000006",
  leaseIdentity: "a".repeat(64),
  fencingToken: 1,
  providerAttemptId: "1-1",
  assignmentStatus: "acknowledged",
  pendingValidationCount: 0,
  validationReceiptCount: 0,
  implementationArtifactCount: 0,
});

const observation = (status, version, extra = {}) => ({
  ...base,
  status,
  aggregateVersion: version,
  projectionEventPosition: version,
  latestEventId: `00000000-0000-4000-8000-${String(version).padStart(12, "0")}`,
  latestEventType: `execution.${status}`,
  latestEventAggregateVersion: version,
  timeoutAt: new Date(10_000),
  ...extra,
});

async function runSequence(statuses, expectedTerminal) {
  let clock = 0;
  const rows = statuses.map((status, index) =>
    observation(status, index + 1, {
      assignmentStatus: index === statuses.length - 1 ? "completed" : "acknowledged",
      validationReceiptCount: status === "succeeded" ? 1 : 0,
      implementationArtifactCount: status === "succeeded" ? 1 : 0,
    }),
  );
  let index = 0;
  return observeGovernedExecutionTerminal({
    initial: rows[0],
    expectedTerminal,
    read: async () => rows[Math.min(++index, rows.length - 1)],
    now: () => clock,
    wait: async (milliseconds) => {
      clock += milliseconds;
    },
  });
}

test("observer accepts governed progress, repeated running, and exact terminal outcomes", async () => {
  const success = await runSequence(
    ["requested", "accepted", "preparing", "running", "running", "verifying", "succeeded"],
    "succeeded",
  );
  assert.equal(success.observation.status, "succeeded");
  for (const terminal of ["failed", "timed_out", "cancelled"])
    assert.equal((await runSequence(["running", terminal], terminal)).observation.status, terminal);
});

test("observer fails closed on transition and immutable authority mutations", () => {
  const running = observation("running", 4);
  assert.throws(() => assertGovernedExecutionObservation(base, running, observation("accepted", 5)), /Illegal/);
  for (const [key, value] of [
    ["executionId", "00000000-0000-4000-8000-000000000099"],
    ["assignmentId", "00000000-0000-4000-8000-000000000098"],
    ["assignmentAttempt", 2],
    ["leaseReceiptId", "00000000-0000-4000-8000-000000000097"],
    ["leaseIdentity", "b".repeat(64)],
    ["fencingToken", 2],
  ])
    assert.throws(
      () => assertGovernedExecutionObservation(base, running, { ...observation("running", 5), [key]: value }),
      new RegExp(String(key)),
    );
  assert.throws(
    () => assertGovernedExecutionObservation(base, running, observation("running", 3)),
    /version regressed/,
  );
  assert.throws(
    () =>
      assertGovernedExecutionObservation(
        base,
        { ...running, providerAttemptId: "1-2" },
        { ...observation("running", 5), providerAttemptId: "1-1" },
      ),
    /generation regressed/,
  );
  assert.throws(
    () =>
      assertGovernedExecutionObservation(base, running, {
        ...observation("running", 5),
        providerAttemptId: "2-1",
      }),
    /not bound to the assignment attempt/,
  );
});

test("bounded timeout reports last authoritative state and provider exit is not terminal", async () => {
  let clock = 9_900;
  const running = observation("running", 4, { timeoutAt: new Date(10_000) });
  await assert.rejects(
    observeGovernedExecutionTerminal({
      initial: running,
      expectedTerminal: "succeeded",
      read: async () => running,
      now: () => clock,
      wait: async (milliseconds) => {
        clock += milliseconds;
      },
    }),
    /"lastState":"running".*"lastAggregateVersion":4.*"expectedTerminal":"succeeded"/,
  );
  assert.throws(() => assertExecutionTerminalEvidenceBarrier(running, "succeeded"), /before.*terminal barrier/);
});

test("terminal evidence and replay quiescence require durable result closure", () => {
  const succeeded = observation("succeeded", 7, {
    assignmentStatus: "completed",
    validationReceiptCount: 1,
    implementationArtifactCount: 1,
  });
  assert.doesNotThrow(() => assertExecutionTerminalEvidenceBarrier(succeeded, "succeeded"));
  assert.throws(
    () => assertExecutionTerminalEvidenceBarrier({ ...succeeded, validationReceiptCount: 0 }, "succeeded"),
    /validation receipt/,
  );
  assert.doesNotThrow(() =>
    assertWorkspaceExecutionQuiescence([
      {
        executionId: succeeded.executionId,
        executionStatus: "succeeded",
        assignmentStatus: "completed",
        liveProviderCount: 0,
        pendingValidationCount: 0,
      },
    ]),
  );
  for (const mutation of [
    { executionStatus: "running" },
    { assignmentStatus: "acknowledged" },
    { liveProviderCount: 1 },
    { pendingValidationCount: 1 },
  ])
    assert.throws(
      () =>
        assertWorkspaceExecutionQuiescence([
          {
            executionId: succeeded.executionId,
            executionStatus: "succeeded",
            assignmentStatus: "completed",
            liveProviderCount: 0,
            pendingValidationCount: 0,
            ...mutation,
          },
        ]),
      /not quiescent/,
    );
});

test("focused restart and lease-loss contracts await terminal evidence", async () => {
  let index = 0;
  let clock = 0;
  const restartRows = [
    observation("running", 4, { providerAttemptId: "1-1" }),
    observation("running", 5, { providerAttemptId: "1-2" }),
    observation("verifying", 6, { providerAttemptId: "1-2" }),
    observation("succeeded", 7, {
      providerAttemptId: "1-2",
      assignmentStatus: "completed",
      validationReceiptCount: 1,
      implementationArtifactCount: 1,
    }),
  ];
  const restarted = await observeGovernedExecutionTerminal({
    initial: restartRows[0],
    expectedTerminal: "succeeded",
    read: async () => restartRows[Math.min(++index, restartRows.length - 1)],
    now: () => clock,
    wait: async (milliseconds) => {
      clock += milliseconds;
    },
  });
  assert.equal(restarted.observation.providerAttemptId, "1-2");
  assertExecutionTerminalEvidenceBarrier(restarted.observation, "succeeded");
  const leaseLoss = await runSequence(["running", "cancelled"], "cancelled");
  assert.equal(leaseLoss.observation.status, "cancelled");
});

test("authenticated harness observes Mission Agent leader exit and bounds descendant quiescence", async () => {
  const source = await readFile(new URL("../scripts/run-consensus-real-acceptance.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function runAgent(");
  const end = source.indexOf("async function runHeartbeat(", start);
  const body = source.slice(start, end);
  assert.match(body, /child\.once\("exit"/);
  assert.doesNotMatch(body, /child\.once\("close"/);
  assert.match(body, /awaitBoundedProcessGroupExit/);
  assert.match(body, /exceeded its bounded execution timeout/);
});
