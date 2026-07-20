import assert from "node:assert/strict";
import test from "node:test";
import { createRecommendation, rehydrateRecommendation, transitionRecommendation } from "../domain/recommendation.ts";

const input = {
  repositoryId: "repo",
  sourceMissionId: "mission",
  sourceExecutionId: "execution",
  title: "Refactor authentication",
  description: "Extract duplicated JWT handling",
  reasoning: "Three paths duplicate token validation",
  evidence: [{ path: "src/auth.ts", line: 42 }],
  estimatedImpact: "high",
  estimatedRisk: "medium",
  estimatedEffort: "3-5 hours",
  suggestedValidation: ["npm test"],
  acceptanceCriteria: ["All authentication paths use the shared service"],
};
test("recommendations require structured evidence, acceptance criteria, and safe validation", () => {
  assert.equal(createRecommendation(input).eventType, "recommendation.created");
  assert.throws(() => createRecommendation({ ...input, evidence: [] }), /evidence is required/);
  assert.throws(() => createRecommendation({ ...input, suggestedValidation: ["rm -rf ."] }), /not allowed/);
  assert.throws(() => createRecommendation({ ...input, suggestedValidation: ["npm test ../other"] }), /not allowed/);
  assert.doesNotThrow(() => createRecommendation({ ...input, suggestedValidation: ["go test ./..."] }));
});
test("recommendation lifecycle is explicit and terminal states cannot reopen", () => {
  const events = [{ aggregateId: "rec", aggregateVersion: 1, payload: { status: "open" } }];
  const state = rehydrateRecommendation(events);
  assert.equal(transitionRecommendation(state, "accepted").payload.status, "accepted");
  assert.equal(
    transitionRecommendation(state, "in_progress", { linkedMissionId: "mission-2" }).payload.linkedMissionId,
    "mission-2",
  );
  assert.throws(() => transitionRecommendation({ ...state, status: "completed" }, "open"), /Invalid/);
});
