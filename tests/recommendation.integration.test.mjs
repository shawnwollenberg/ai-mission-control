import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
const { getDatabasePool, closeDatabasePool } = await import("../lib/database.ts");
const { recordRepositoryRecommendations, changeRecommendationStatus } =
  await import("../application/recommendation-commands.ts");
const { getRecommendation } = await import("../application/recommendation-queries.ts");
const { applyRecommendationProjection } = await import("../application/recommendation-projector.ts");
const { loadAggregateEvents } = await import("../lib/postgres-event-store.ts");
const workspaceId = randomUUID(),
  repositoryId = randomUUID(),
  missionId = randomUUID(),
  executionId = randomUUID();
test.before(async () => {
  await getDatabasePool().query("INSERT INTO workspaces(id,slug,name) VALUES($1,$2,'Recommendation Test')", [
    workspaceId,
    `recommendation-${workspaceId}`,
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
test("recommendation persists provenance, lifecycle, and rebuild equality", async () => {
  const [recommendationId] = await recordRepositoryRecommendations({
    actor: { workspaceId, id: "analysis-agent", type: "agent" },
    commandId: randomUUID(),
    repositoryId,
    sourceMissionId: missionId,
    sourceExecutionId: executionId,
    recommendations: [
      {
        title: "Refactor authentication",
        description: "Extract duplicated JWT validation",
        reasoning: "Three entry points repeat the same checks",
        evidence: [{ path: "src/auth.ts", line: 42, description: "Repeated validation" }],
        estimatedImpact: "high",
        estimatedRisk: "medium",
        estimatedEffort: "3-5 hours",
        suggestedValidation: ["npm test"],
        acceptanceCriteria: ["All authentication paths use one validator"],
      },
    ],
  });
  let projected = await getRecommendation(workspaceId, recommendationId);
  assert.equal(projected.status, "open");
  assert.equal(projected.sourceMissionId, missionId);
  assert.equal(projected.evidence[0].path, "src/auth.ts");
  const linkedMissionId = randomUUID();
  await changeRecommendationStatus({
    actor: { workspaceId, id: "owner", type: "human" },
    commandId: randomUUID(),
    recommendationId,
    target: "in_progress",
    linkedMissionId,
    reason: "Change mission created",
  });
  projected = await getRecommendation(workspaceId, recommendationId);
  assert.equal(projected.status, "in_progress");
  assert.equal(projected.linkedMissionId, linkedMissionId);
  const before = JSON.stringify(projected);
  await getDatabasePool().query(
    "DELETE FROM recommendation_projections WHERE workspace_id=$1 AND recommendation_id=$2",
    [workspaceId, recommendationId],
  );
  const events = await loadAggregateEvents({
    workspaceId,
    aggregateType: "recommendation",
    aggregateId: recommendationId,
  });
  const client = await getDatabasePool().connect();
  try {
    for (const event of events) await applyRecommendationProjection(client, [event]);
  } finally {
    client.release();
  }
  const rebuilt = await getRecommendation(workspaceId, recommendationId);
  assert.equal(JSON.stringify(rebuilt), before);
});
