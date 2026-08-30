import assert from "node:assert/strict";
import test from "node:test";
import { MemoryWorkerCoordinationStore } from "../v2/worker/store.ts";
import { validateWorkerHealth, validateWorkerResult } from "../v2/worker/protocol.ts";
import { coordinationBackoffMs, runWorkerPollingLoop } from "../v2/worker/polling.ts";
import { failedDispatchRecovery, isIndeterminateFailure } from "../v2/worker/recovery.ts";

const constitution = {
  schema: "mc.project-constitution/v1",
  projectId: "one",
  repository: "owner/one",
  defaultBranch: "main",
  architect: { adapter: "codex-sdk", channel: "CHATGPT" },
  engineer: { adapter: "codex-sdk" },
  authority: { engineer: ["CODE_WRITE"], architect: ["MISSION_APPROVE"], ctoRequired: ["REPO_PUSH"] },
};
const mission = {
  schema: "mc.mission/v1",
  missionId: "mission-one",
  revision: 1,
  objective: "Test",
  acceptanceCriteria: ["passes"],
  constraints: ["no deploy"],
  state: "ENGINEER_WORKING",
  currentActor: "ENGINEER",
};
const input = {
  projectId: "one",
  missionId: mission.missionId,
  issueNumber: 1,
  missionRevision: 1,
  actor: "ENGINEER",
  adapter: "codex-sdk",
  idempotencyKey: "mission-one:1:engineer",
  missionDigest: "a".repeat(64),
  packet: { mission, constitution },
};
const health = (sessionId = "11111111-1111-4111-8111-111111111111") => ({
  schema: "mc.worker-health/v1",
  workerId: "opaque-owner-worker",
  displayName: "Owner Mac",
  sessionId,
  status: "ONLINE",
  architectAvailable: true,
  engineerAvailable: true,
});

test("dispatch enqueue, claim, exact result, and duplicate upload are idempotent", async () => {
  const store = new MemoryWorkerCoordinationStore();
  const first = await store.enqueue(input);
  assert.equal((await store.enqueue(input)).dispatchId, first.dispatchId);
  const dispatch = await store.claim(health(), 45_000);
  const result = {
    schema: "mc.worker-result/v1",
    dispatchId: dispatch.dispatchId,
    idempotencyKey: dispatch.idempotencyKey,
    missionId: dispatch.missionId,
    missionRevision: 1,
    actor: "ENGINEER",
    providerThreadId: "engineer-thread-one",
    result: {
      schema: "mc.engineer-report/v1",
      missionId: mission.missionId,
      revision: 2,
      outcome: "COMPLETED",
      summary: "done",
      evidence: [{ kind: "test", ref: "local", result: "pass" }],
      risks: [],
      blockedOn: [],
      capabilitiesRequested: [],
    },
  };
  validateWorkerResult(result, dispatch);
  assert.equal((await store.complete(health(), result)).duplicate, false);
  assert.equal((await store.complete(health(), result)).duplicate, true);
  await assert.rejects(() => store.complete(health(), { ...result, providerThreadId: "forged" }), /Conflicting/);
});

test("stale and role-confused results fail exact dispatch validation", async () => {
  const store = new MemoryWorkerCoordinationStore();
  const dispatch = await store.enqueue(input);
  const result = {
    schema: "mc.worker-result/v1",
    dispatchId: dispatch.dispatchId,
    idempotencyKey: dispatch.idempotencyKey,
    missionId: dispatch.missionId,
    missionRevision: 0,
    actor: "ARCHITECT",
    providerThreadId: "wrong",
    result: {
      schema: "mc.architect-decision/v1",
      missionId: mission.missionId,
      revision: 2,
      decision: "APPROVE",
      rationale: "wrong role",
      nextMission: null,
    },
  };
  assert.throws(() => validateWorkerResult(result, dispatch), /exact dispatch binding/);
});

test("second active session is rejected and offline is operational only", async () => {
  let now = new Date("2026-08-29T12:00:00Z");
  const store = new MemoryWorkerCoordinationStore(() => now);
  await store.enqueue(input);
  await store.claim(health(), 45_000);
  await assert.rejects(() => store.claim(health("22222222-2222-4222-8222-222222222222"), 45_000), /DUPLICATE/);
  now = new Date("2026-08-29T12:01:00Z");
  assert.equal((await store.presence(30_000)).status, "OFFLINE");
  assert.equal((await store.list())[0].status, "CLAIMED");
});

test("heartbeat records worker presence before external coordination work", async () => {
  const store = new MemoryWorkerCoordinationStore();
  await store.heartbeat(health());
  assert.equal((await store.presence(75_000)).status, "ONLINE");
  assert.equal((await store.list()).length, 0);
});

test("three projects remain isolated and only one dispatch is claimed at a time", async () => {
  const store = new MemoryWorkerCoordinationStore();
  for (let index = 1; index <= 3; index++)
    await store.enqueue({
      ...input,
      projectId: `project-${index}`,
      missionId: `mission-${index}`,
      issueNumber: index,
      idempotencyKey: `mission-${index}:1:engineer`,
      packet: { ...input.packet, mission: { ...mission, missionId: `mission-${index}` } },
    });
  const claimed = await store.claim(health(), 45_000);
  assert.equal(claimed.projectId, "project-1");
  assert.equal((await store.list()).filter((item) => item.status === "QUEUED").length, 2);
  assert.equal(new Set((await store.list()).map((item) => item.dispatch.missionId)).size, 3);
});

test("offline queued work resumes after the personal worker reconnects without changing Mission truth", async () => {
  let now = new Date("2026-08-29T12:00:00Z");
  const store = new MemoryWorkerCoordinationStore(() => now);
  const first = await store.enqueue(input);
  assert.equal((await store.claim(health(), 45_000)).dispatchId, first.dispatchId);
  const queued = await store.enqueue({
    ...input,
    missionId: "mission-offline",
    issueNumber: 2,
    idempotencyKey: "mission-offline:1:engineer",
    packet: { ...input.packet, mission: { ...mission, missionId: "mission-offline" } },
  });
  now = new Date("2026-08-29T12:01:00Z");
  assert.equal((await store.presence(30_000)).status, "OFFLINE");
  assert.equal((await store.list()).find((item) => item.dispatch.dispatchId === queued.dispatchId).status, "QUEUED");
  const resumed = await store.claim(health("33333333-3333-4333-8333-333333333333"), 45_000);
  assert.equal(resumed.dispatchId, first.dispatchId);
  assert.equal(resumed.missionRevision, 1);
  assert.equal((await store.presence(30_000)).status, "ONLINE");
});

test("failed dispatch recovery is explicit, actor-bound, and does not recover completed provider work", async () => {
  const store = new MemoryWorkerCoordinationStore();
  const dispatch = await store.enqueue(input);
  await store.claim(health(), 45_000);
  await store.fail(health(), dispatch.dispatchId, "PROVIDER_THREAD_UNAVAILABLE");
  assert.equal((await store.list())[0].failureCode, "PROVIDER_THREAD_UNAVAILABLE");
  assert.equal((await store.enqueue(input)).dispatchId, dispatch.dispatchId);
  assert.equal((await store.list())[0].status, "FAILED", "enqueue alone cannot conceal a failed dispatch");
  assert.equal(await store.recoverFailed(dispatch.dispatchId), "ENGINEER_THREAD_REPLACEMENT");
  assert.equal((await store.list())[0].status, "QUEUED");
  assert.equal(
    (await store.list())[0].failureCode,
    "PROVIDER_THREAD_UNAVAILABLE",
    "the bounded recovery reason remains visible until completion",
  );

  await store.claim(health(), 45_000);
  await store.fail(health(), dispatch.dispatchId, "PROVIDER_RECOVERY_EXHAUSTED");
  await store.enqueue(input);
  assert.equal(await store.recoverFailed(dispatch.dispatchId), undefined);
  assert.equal((await store.list())[0].status, "FAILED");
  assert.equal((await store.list())[0].failureCode, "PROVIDER_RECOVERY_EXHAUSTED");

  const completedStore = new MemoryWorkerCoordinationStore();
  const completed = await completedStore.enqueue(input);
  const claimed = await completedStore.claim(health(), 45_000);
  await completedStore.complete(health(), {
    schema: "mc.worker-result/v1",
    dispatchId: claimed.dispatchId,
    idempotencyKey: claimed.idempotencyKey,
    missionId: claimed.missionId,
    missionRevision: claimed.missionRevision,
    actor: claimed.actor,
    providerThreadId: "durable-result-thread",
    result: {
      schema: "mc.engineer-report/v1",
      missionId: claimed.missionId,
      revision: claimed.missionRevision + 1,
      outcome: "COMPLETED",
      summary: "provider result is already durable",
      evidence: [],
      risks: [],
      blockedOn: [],
      capabilitiesRequested: [],
    },
  });
  assert.equal(await completedStore.recoverFailed(completed.dispatchId), undefined);
  assert.equal((await completedStore.list())[0].status, "COMPLETED");
});

test("read-only Architect replacement is bounded while indeterminate and ineligible Engineer failures fail closed", async () => {
  assert.equal(failedDispatchRecovery("ARCHITECT", "PROVIDER_PROCESS_FAILED"), "READ_ONLY_ARCHITECT_REPLACEMENT");
  assert.equal(failedDispatchRecovery("ARCHITECT", "PROVIDER_OUTPUT_INVALID"), "READ_ONLY_ARCHITECT_REPLACEMENT");
  assert.equal(failedDispatchRecovery("ENGINEER", "PROVIDER_PROCESS_FAILED"), undefined);
  assert.equal(failedDispatchRecovery("ENGINEER", "PROVIDER_DISPATCH_INDETERMINATE"), undefined);
  assert.equal(failedDispatchRecovery("ARCHITECT", "PROVIDER_DISPATCH_INDETERMINATE"), undefined);
  assert.equal(isIndeterminateFailure("PROVIDER_DISPATCH_INDETERMINATE"), true);
  assert.equal(
    failedDispatchRecovery("ARCHITECT", "PROVIDER_RECOVERY_EXHAUSTED"),
    undefined,
    "a second eligible failure is terminal",
  );

  const store = new MemoryWorkerCoordinationStore();
  const architectInput = {
    ...input,
    actor: "ARCHITECT",
    idempotencyKey: "mission-one:1:architect",
  };
  const dispatch = await store.enqueue(architectInput);
  await store.claim(health(), 45_000);
  await store.fail(health(), dispatch.dispatchId, "PROVIDER_PROCESS_FAILED");
  assert.equal(await store.recoverFailed(dispatch.dispatchId), "READ_ONLY_ARCHITECT_REPLACEMENT");
  assert.equal((await store.list())[0].status, "QUEUED");

  const indeterminate = new MemoryWorkerCoordinationStore();
  const unsafe = await indeterminate.enqueue(input);
  await indeterminate.claim(health(), 45_000);
  await indeterminate.fail(health(), unsafe.dispatchId, "PROVIDER_DISPATCH_INDETERMINATE");
  assert.equal(await indeterminate.recoverFailed(unsafe.dispatchId), undefined);
  assert.equal((await indeterminate.list())[0].status, "FAILED");
});

test("transient coordination failures use bounded backoff and the polling loop survives", async () => {
  assert.equal(coordinationBackoffMs(1, 30_000), 30_000);
  assert.equal(coordinationBackoffMs(5, 30_000), 300_000);
  assert.equal(coordinationBackoffMs(30, 30_000), 300_000);

  let attempts = 0;
  let stopped = false;
  const retries = [];
  const delays = [];
  let heartbeats = 0;
  await runWorkerPollingLoop({
    tick: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("transient hosted failure");
      stopped = true;
    },
    heartbeat: async () => {
      heartbeats += 1;
    },
    delay: async (milliseconds) => {
      delays.push(milliseconds);
    },
    intervalMs: 30_000,
    once: false,
    shouldStop: () => stopped,
    onCoordinationRetry: (backoffMs) => retries.push(backoffMs),
  });
  assert.equal(attempts, 3, "the worker continues after transient failures");
  assert.deepEqual(retries, [30_000, 60_000]);
  assert.deepEqual(delays, [30_000, 30_000, 30_000]);
  assert.equal(heartbeats, 1, "longer backoff reports presence without GitHub synchronization");
});

test("worker health accepts only explicit provider failure codes", () => {
  assert.equal(
    validateWorkerHealth({ ...health(), status: "DEGRADED", failureCode: "PROVIDER_THREAD_UNAVAILABLE" }).failureCode,
    "PROVIDER_THREAD_UNAVAILABLE",
  );
  assert.throws(
    () => validateWorkerHealth({ ...health(), status: "DEGRADED", failureCode: "UNBOUNDED_RETRY" }),
    /Invalid worker health envelope/,
  );
});
