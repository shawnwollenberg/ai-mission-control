import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { closeDatabasePool, getDatabasePool } from "../lib/database.ts";
import { PostgresWorkerCoordinationStore } from "../v2/worker/store.ts";

test("PostgreSQL worker ledger atomically claims, rejects a duplicate session, and audits a result", async () => {
  const store = new PostgresWorkerCoordinationStore();
  const suffix = randomUUID();
  const workerId = `test-${suffix}`;
  const missionId = `test-${suffix}`;
  const sessionId = randomUUID();
  const health = {
    schema: "mc.worker-health/v1",
    workerId,
    displayName: "Test Worker",
    sessionId,
    status: "ONLINE",
    architectAvailable: true,
    engineerAvailable: true,
  };
  const mission = {
    schema: "mc.mission/v1",
    missionId,
    revision: 1,
    objective: "integration",
    acceptanceCriteria: ["pass"],
    constraints: [],
    state: "ENGINEER_WORKING",
    currentActor: "ENGINEER",
  };
  try {
    const dispatch = await store.enqueue({
      projectId: `project-${suffix}`,
      missionId,
      issueNumber: 1,
      missionRevision: 1,
      actor: "ENGINEER",
      adapter: "codex-sdk",
      idempotencyKey: `${missionId}:1:engineer`,
      missionDigest: "b".repeat(64),
      packet: {
        mission,
        constitution: {
          schema: "mc.project-constitution/v1",
          projectId: `project-${suffix}`,
          repository: "owner/repo",
          defaultBranch: "main",
          architect: { adapter: "codex-sdk", channel: "CHATGPT" },
          engineer: { adapter: "codex-sdk" },
          authority: { engineer: ["CODE_WRITE"], architect: ["MISSION_APPROVE"], ctoRequired: ["REPO_PUSH"] },
        },
      },
    });
    assert.equal((await store.claim(health, 45_000)).dispatchId, dispatch.dispatchId);
    await assert.rejects(() => store.claim({ ...health, sessionId: randomUUID() }, 45_000), /DUPLICATE/);
    const result = {
      schema: "mc.worker-result/v1",
      dispatchId: dispatch.dispatchId,
      idempotencyKey: dispatch.idempotencyKey,
      missionId,
      missionRevision: 1,
      actor: "ENGINEER",
      providerThreadId: "thread-test",
      result: {
        schema: "mc.engineer-report/v1",
        missionId,
        revision: 2,
        outcome: "COMPLETED",
        summary: "pass",
        evidence: [{ kind: "test", ref: "integration" }],
        risks: [],
        blockedOn: [],
        capabilitiesRequested: [],
      },
    };
    assert.equal((await store.complete(health, result)).duplicate, false);
    await store.markCommitted(dispatch.dispatchId, 2);
    const audit = (await store.list()).find((item) => item.dispatch.dispatchId === dispatch.dispatchId);
    assert.deepEqual(
      { status: audit.status, revision: audit.resultingGitHubRevision, thread: audit.providerThreadId },
      { status: "COMPLETED", revision: 2, thread: "thread-test" },
    );
  } finally {
    const pool = getDatabasePool();
    await pool.query("DELETE FROM v2_worker_dispatches WHERE mission_id=$1", [missionId]);
    await pool.query("DELETE FROM v2_worker_presence WHERE worker_id=$1", [workerId]);
    await closeDatabasePool();
  }
});
