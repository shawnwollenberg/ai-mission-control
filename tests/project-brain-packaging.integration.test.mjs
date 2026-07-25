import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
const { closeDatabasePool, getDatabasePool } = await import("../lib/database.ts");
const { requestProjectBrainOperation } = await import("../application/project-brain-commands.ts");
const { executeProjectBrainOperation } = await import("../integrations/project-brain/worker.ts");

test.after(closeDatabasePool);

test("production packaging modes deny commands and local routing canonically", async () => {
  const workspaceId = randomUUID();
  const repositoryId = randomUUID();
  const actor = { workspaceId, id: randomUUID(), type: "human" };
  await getDatabasePool().query("INSERT INTO workspaces(id,slug,name) VALUES($1,$2,$3)", [
    workspaceId,
    `pb-packaging-${workspaceId}`,
    "Project Brain packaging integration",
  ]);
  await getDatabasePool().query(
    `INSERT INTO repositories(
       workspace_id,repository_id,name,local_path,default_branch,allowed_agent_ids,read_allowed,write_allowed,
       commit_allowed,push_allowed,merge_allowed,deployment_allowed,validation_commands,project_brain_enabled,
       location_mode,observed_commit
     ) VALUES($1,$2,'server','/repositories/unavailable','main','[]',true,false,false,false,false,false,'[]',
       true,'server',$3)`,
    [workspaceId, repositoryId, "a".repeat(40)],
  );

  process.env.PROJECT_BRAIN_EXECUTION_MODE = "disabled";
  const disabled = await requestProjectBrainOperation({
    actor,
    request: {
      repositoryId,
      operation: "detect_repository",
      idempotencyKey: randomUUID(),
    },
  });
  assert.equal(disabled.authorized, false);
  assert.ok(disabled.reasons.includes("project_brain_execution_disabled"));

  delete process.env.PROJECT_BRAIN_EXECUTION_MODE;
  delete process.env.PROJECT_BRAIN_LOCAL_EXECUTION;
  const requested = await requestProjectBrainOperation({
    actor,
    request: {
      repositoryId,
      operation: "detect_repository",
      idempotencyKey: randomUUID(),
    },
  });
  assert.equal(requested.authorized, true);
  process.env.APP_ENV = "production";
  process.env.PROJECT_BRAIN_LOCAL_EXECUTION = "disabled";
  const result = await executeProjectBrainOperation({
    workspaceId,
    operationId: requested.operationId,
    workerId: "packaging-routing-test",
  });
  assert.equal(result.status, "denied");
  const projection = (
    await getDatabasePool().query(
      "SELECT status,failure_cause FROM project_brain_operation_projections WHERE workspace_id=$1 AND operation_id=$2",
      [workspaceId, requested.operationId],
    )
  ).rows[0];
  assert.equal(projection.status, "denied");
  assert.match(projection.failure_cause, /local_project_brain_execution_disabled/);
});
