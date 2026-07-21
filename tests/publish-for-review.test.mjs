import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Mission Agent publication is exact, non-force, evidence-bound, and separate from merge", async () => {
  const source = await readFile("public/mission-agent-0.6.0.mjs", "utf8");
  assert.match(source, /The local branch or commit changed after Publish for Review was approved/);
  assert.match(source, /sha256\(patch\.stdout\)/);
  assert.match(source, /Force push is never permitted/);
  assert.match(
    source,
    /\["push", publication\.remote, `\$\{publication\.commit\}:refs\/heads\/\$\{publication\.branch\}`\]/,
  );
  assert.doesNotMatch(source, /--force|-f", publication/);
  assert.doesNotMatch(source, /gh", \["pr", "merge"/);
});

test("pull-request evidence includes traceability and the bounded authority statement", async () => {
  const source = await readFile("application/action-commands.ts", "utf8");
  for (const heading of [
    "Objective",
    "Source recommendation",
    "Acceptance criteria",
    "Implementation evidence",
    "Validation",
    "Limitations and risks",
    "Rollback",
    "Mission traceability",
  ])
    assert.match(source, new RegExp(heading));
  assert.match(source, /Human-approved authority: publish this exact local commit for review/);
  assert.match(source, /evidenceChecksum/);
});

test("provider verification retries an already-pushed exact publication without another approval", async () => {
  const assignments = await readFile("application/publication-assignments.ts", "utf8");
  const executor = await readFile("application/action-executor.ts", "utf8");
  assert.match(assignments, /status IN\('available','claimed','pushed'\)/);
  assert.match(executor, /ar\.status IN\('executing','failed'\) AND pa\.status='pushed'/);
  assert.match(executor, /reconcileFailedActionExecution/);
  assert.match(executor, /process\.env\.GITHUB_TOKEN \?\? process\.env\.GH_TOKEN/);
  assert.match(executor, /confirmed\.head\.sha !== parameters\.commit/);
  const consoleSource = await readFile("app/missions/[missionId]/durable-mission-console.tsx", "utf8");
  assert.match(consoleSource, /\["repository\.push_branch", "repository\.publish_for_review"\]/);
  const timeline = await readFile("lib/mission-queries.ts", "utf8");
  assert.match(timeline, /"action\.execution_reconciliation_started": "Action verification resumed"/);
  const projections = await readFile("scripts/projections.ts", "utf8");
  assert.match(projections, /to_jsonb\(x\) - 'last_heartbeat_at'/);
});
