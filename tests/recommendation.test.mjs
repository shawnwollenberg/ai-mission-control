import assert from "node:assert/strict";
import test from "node:test";
import { parseRepositoryRecommendations } from "../application/remote-agent-messages.ts";
import {
  assertSafeRecommendationValidation,
  createRecommendation,
  rehydrateRecommendation,
  transitionRecommendation,
} from "../domain/recommendation.ts";

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
test("production-rejected inline evaluation remains prohibited while canonical direct commands remain allowed", () => {
  const productionRejected =
    "node -e \"const fs=require('fs');const c=fs.readFileSync('.git/config','utf8');if(/github\\\\.com\\\\/example\\\\//.test(c)||!c.includes('[branch \\\\\"main\\\\\"]'))process.exit(1)\"";
  assert.throws(
    () => assertSafeRecommendationValidation(productionRejected),
    /inline code and shell operators are prohibited/,
  );
  for (const command of [
    "npm test",
    "npm run lint",
    "npm run build",
    "pnpm test",
    "yarn test",
    "bun test",
    "node --test",
    "go test ./...",
    "cargo test",
    "pytest tests/unit",
  ])
    assert.doesNotThrow(() => assertSafeRecommendationValidation(command), command);
});
test("recommendation validation rejects adversarial command forms without broadening execution", () => {
  for (const command of [
    "",
    "node -e process.exit(0)",
    "node --eval=process.exit(0)",
    "npm test -- --output=../../outside",
    "npm test ../outside",
    "npm test; rm -rf .",
    "npm test && node evil.js",
    "npm test || true",
    "npm test | tee result",
    "npm test > result",
    "npm test 2>&1",
    "npm $(echo test)",
    "npm `echo test`",
    "NODE_OPTIONS=--require=evil npm test",
    "npm test $SECRET",
    "sh -c npm test",
    "bash -c npm test",
    "curl https://example.invalid",
    "sudo npm test",
    "rm -rf .",
    "/usr/bin/npm test",
    "npm run preinstall",
    "pnpm run postinstall",
    "yarn run prepare",
    "bun run publish",
  ])
    assert.throws(() => assertSafeRecommendationValidation(command), command);
});
test("recommendation ingestion normalizes one structured evidence object without weakening validation", () => {
  const [parsed] = parseRepositoryRecommendations(
    Buffer.from(JSON.stringify([{ ...input, evidence: input.evidence[0] }])),
  );
  assert.deepEqual(parsed.evidence, input.evidence);
  assert.throws(
    () =>
      parseRepositoryRecommendations(
        Buffer.from(JSON.stringify([{ ...input, evidence: { path: "../outside", line: 1 } }])),
      ),
    /path is unsafe/,
  );
  const [missing] = parseRepositoryRecommendations(Buffer.from(JSON.stringify([{ ...input, evidence: null }])));
  assert.throws(() => createRecommendation({ ...input, evidence: missing.evidence }), /evidence is required/);
});
test("recommendation ingestion normalizes singular criteria and validation without accepting blanks", () => {
  const [parsed] = parseRepositoryRecommendations(
    Buffer.from(
      JSON.stringify([
        {
          ...input,
          acceptanceCriteria: "All authentication paths use the shared service",
          suggestedValidation: "npm test",
        },
      ]),
    ),
  );
  assert.deepEqual(parsed.acceptanceCriteria, ["All authentication paths use the shared service"]);
  assert.deepEqual(parsed.suggestedValidation, ["npm test"]);
  assert.doesNotThrow(() => createRecommendation({ ...input, ...parsed }));

  const [blank] = parseRepositoryRecommendations(
    Buffer.from(JSON.stringify([{ ...input, acceptanceCriteria: "   " }])),
  );
  assert.throws(() => createRecommendation({ ...input, ...blank }), /acceptance criteria are required/);
});
test("recommendation lifecycle is explicit and terminal states cannot reopen", () => {
  const events = [{ aggregateId: "rec", aggregateVersion: 1, payload: { status: "open" } }];
  const state = rehydrateRecommendation(events);
  assert.equal(transitionRecommendation(state, "accepted").payload.status, "accepted");
  assert.equal(
    transitionRecommendation(state, "in_progress", { linkedMissionId: "mission-2" }).payload.linkedMissionId,
    "mission-2",
  );
  assert.equal(
    transitionRecommendation({ ...state, status: "in_progress", linkedMissionId: "failed-mission" }, "in_progress", {
      linkedMissionId: "retry-mission",
    }).payload.linkedMissionId,
    "retry-mission",
  );
  assert.equal(
    transitionRecommendation({ ...state, status: "completed" }, "in_progress", {
      linkedMissionId: "follow-up-mission",
    }).payload.linkedMissionId,
    "follow-up-mission",
  );
  assert.throws(() => transitionRecommendation({ ...state, status: "completed" }, "open"), /Invalid/);
});
