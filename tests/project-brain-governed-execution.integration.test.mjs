import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
const { getDatabasePool, closeDatabasePool } = await import("../lib/database.ts");
const { requestProjectBrainOperation } = await import("../application/project-brain-commands.ts");
const { processOneOutbox } = await import("../lib/outbox-dispatcher.ts");
const { claimJob, failJob } = await import("../lib/job-store.ts");
const { executeProjectBrainOperation } = await import("../integrations/project-brain/worker.ts");

const workspaceId = randomUUID();
const serverRepositoryId = randomUUID();
const remoteRepositoryId = randomUUID();
const actor = { workspaceId, id: randomUUID(), type: "human" };

test.before(async () => {
  await getDatabasePool().query("INSERT INTO workspaces(id,slug,name) VALUES($1,$2,'Project Brain Governance')", [
    workspaceId,
    `pb-${workspaceId}`,
  ]);
  await getDatabasePool().query(
    `INSERT INTO repositories(
      workspace_id,repository_id,name,local_path,default_branch,allowed_agent_ids,read_allowed,write_allowed,
      commit_allowed,push_allowed,merge_allowed,deployment_allowed,validation_commands,project_brain_enabled,
      location_mode,observed_commit
    ) VALUES
      ($1,$2,'server','/tmp/nonexistent-project-brain-fixture','main','[]',true,false,false,false,false,false,'[]',true,'server',$4),
      ($1,$3,'remote',$5,'main','[]',true,false,false,false,false,false,'[]',true,'mission_agent',$4)`,
    [workspaceId, serverRepositoryId, remoteRepositoryId, "a".repeat(40), `mission-agent://${"b".repeat(64)}`],
  );
});
test.after(closeDatabasePool);

test("authorized read creates canonical events, projection, outbox, and one leased job", async () => {
  const commandId = randomUUID();
  const requested = await requestProjectBrainOperation({
    actor,
    request: {
      repositoryId: serverRepositoryId,
      operation: "get_summary",
      idempotencyKey: commandId,
    },
  });
  assert.equal(requested.authorized, true);
  const duplicate = await requestProjectBrainOperation({
    actor,
    request: {
      operationId: requested.operationId,
      repositoryId: serverRepositoryId,
      operation: "get_summary",
      idempotencyKey: commandId,
    },
  });
  assert.equal(duplicate.events.length, 2);
  const events = await getDatabasePool().query(
    "SELECT event_type FROM events WHERE workspace_id=$1 AND aggregate_id=$2 ORDER BY aggregate_version",
    [workspaceId, requested.operationId],
  );
  assert.deepEqual(
    events.rows.map((row) => row.event_type),
    ["project_brain.operation_requested", "project_brain.operation_authorized"],
  );
  assert.equal(
    (
      await getDatabasePool().query(
        "SELECT status FROM project_brain_operation_projections WHERE workspace_id=$1 AND operation_id=$2",
        [workspaceId, requested.operationId],
      )
    ).rows[0].status,
    "authorized",
  );
  let job;
  for (let index = 0; index < 100 && !job; index += 1) {
    await processOneOutbox("project-brain-outbox-test", workspaceId);
    job = await claimJob("project-brain-worker-test", 30, workspaceId, "project_brain_operation");
  }
  assert.ok(job);
  assert.equal(job.payload.operationId, requested.operationId);
  await failJob(job, "project-brain-worker-test", new Error("simulated crash after claim"));
});

test("repository write without exact approval is durably denied and never enqueued", async () => {
  const requested = await requestProjectBrainOperation({
    actor,
    request: {
      repositoryId: serverRepositoryId,
      missionId: randomUUID(),
      operation: "record_closure",
      startingSha: "a".repeat(40),
      arguments: { closure: "verified" },
      idempotencyKey: randomUUID(),
    },
  });
  assert.equal(requested.authorized, false);
  assert.ok(requested.reasons.includes("repository_write_denied"));
  assert.ok(requested.reasons.includes("approval_missing"));
  const outbox = await getDatabasePool().query(
    "SELECT count(*)::int count FROM outbox WHERE workspace_id=$1 AND payload->>'operationId'=$2",
    [workspaceId, requested.operationId],
  );
  assert.equal(outbox.rows[0].count, 0);
});

test("remote repository without a compatible agent stays durably fail-closed", async () => {
  const requested = await requestProjectBrainOperation({
    actor,
    request: {
      repositoryId: remoteRepositoryId,
      operation: "get_health",
      idempotencyKey: randomUUID(),
    },
  });
  await assert.doesNotReject(() =>
    executeProjectBrainOperation({
      workspaceId,
      operationId: requested.operationId,
      workerId: "remote-routing-test",
      finalAttempt: true,
    }),
  );
  const projection = (
    await getDatabasePool().query(
      "SELECT status,failure_cause FROM project_brain_operation_projections WHERE workspace_id=$1 AND operation_id=$2",
      [workspaceId, requested.operationId],
    )
  ).rows[0];
  assert.equal(projection.status, "denied");
  assert.match(projection.failure_cause, /remote_agent_required/);
});
