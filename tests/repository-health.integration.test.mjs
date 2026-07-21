import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
const { getDatabasePool, closeDatabasePool } = await import("../lib/database.ts");
const { recordRepositoryHealthAssessment } = await import("../application/repository-health-commands.ts");
const { listRepositoryHealthAssessments, listRepositoryTimeline } =
  await import("../application/repository-health-queries.ts");
const { applyRepositoryHealthProjection } = await import("../application/repository-health-projector.ts");
const { loadAggregateEvents } = await import("../lib/postgres-event-store.ts");
const workspaceId = randomUUID(),
  repositoryId = randomUUID(),
  missionId = randomUUID(),
  executionId = randomUUID();
test.before(async () => {
  await getDatabasePool().query("INSERT INTO workspaces(id,slug,name) VALUES($1,$2,'Health Test')", [
    workspaceId,
    `health-${workspaceId}`,
  ]);
  await getDatabasePool().query(
    "INSERT INTO repositories(workspace_id,repository_id,name,local_path,default_branch) VALUES($1,$2,'sample',$3,'main')",
    [workspaceId, repositoryId, `/tmp/${repositoryId}`],
  );
});
test.after(async () => {
  await getDatabasePool().query("DELETE FROM events WHERE workspace_id=$1", [workspaceId]);
  await getDatabasePool().query("DELETE FROM workspaces WHERE id=$1", [workspaceId]);
  await closeDatabasePool();
});
test("repository health persists provenance, trends, and rebuild equality", async () => {
  const commandId = randomUUID();
  const input = {
    actor: { workspaceId, id: "analysis-agent", type: "agent" },
    commandId,
    repositoryId,
    sourceMissionId: missionId,
    sourceExecutionId: executionId,
    sourceArtifactId: randomUUID(),
    repositoryCommit: "abc123",
    observations: [
      {
        dimension: "architecture",
        status: "strength",
        severity: "low",
        summary: "Clear boundaries",
        evidence: [{ path: "src/index.ts", line: 1 }],
      },
      {
        dimension: "tests",
        status: "risk",
        severity: "medium",
        summary: "Coverage gaps",
        evidence: [{ path: "package.json" }],
      },
    ],
  };
  const assessmentId = await recordRepositoryHealthAssessment(input);
  assert.equal(await recordRepositoryHealthAssessment(input), assessmentId);
  let rows = await listRepositoryHealthAssessments(workspaceId, repositoryId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].assessmentId, assessmentId);
  assert.equal(rows[0].score, 93);
  assert.equal(rows[0].confidence, 36);
  const timeline = await listRepositoryTimeline(workspaceId, repositoryId);
  assert.equal(timeline[0].item_type, "health_assessment");
  assert.equal(timeline[0].mission_id, missionId);
  const before = JSON.stringify(rows[0]);
  await getDatabasePool().query(
    "DELETE FROM repository_health_assessments WHERE workspace_id=$1 AND assessment_id=$2",
    [workspaceId, assessmentId],
  );
  const events = await loadAggregateEvents({
    workspaceId,
    aggregateType: "repository_health",
    aggregateId: assessmentId,
  });
  const client = await getDatabasePool().connect();
  try {
    for (const event of events) await applyRepositoryHealthProjection(client, [event]);
  } finally {
    client.release();
  }
  rows = await listRepositoryHealthAssessments(workspaceId, repositoryId);
  assert.equal(JSON.stringify(rows[0]), before);
});
