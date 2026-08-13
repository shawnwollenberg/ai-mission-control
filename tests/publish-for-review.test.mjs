import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Mission Agent publication is exact, non-force, evidence-bound, and separate from merge", async () => {
  const source = await readFile("public/mission-agent-0.6.7.mjs", "utf8");
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

test("publication evidence includes new files and reports local preflight failures", async () => {
  const source = await readFile("public/mission-agent-0.6.7.mjs", "utf8");
  const endpoint = await readFile("app/api/agent-protocol/v1/publications/fail/route.ts", "utf8");
  const inbox = await readFile("app/approvals/inbox.tsx", "utf8");
  const styles = await readFile("app/globals.css", "utf8");
  assert.match(source, /\["diff", "--cached", "--binary", "HEAD"\]/);
  assert.match(source, /AgentPublicationFailed/);
  assert.match(endpoint, /failMissionAgentPublication/);
  assert.match(inbox, /approval-inbox-list/);
  assert.match(styles, /\.approval-inbox-list \{/);
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

test("ambiguous provider confirmation offers non-publishing reconciliation before a new attempt", async () => {
  const consoleSource = await readFile("app/missions/[missionId]/durable-mission-console.tsx", "utf8");
  const route = await readFile("app/api/actions/[actionRequestId]/reconcile-publication/route.ts", "utf8");
  assert.match(consoleSource, /Confirm Existing Pull Request/);
  assert.match(consoleSource, /without pushing or creating another/);
  assert.match(consoleSource, /Start New Publication Attempt/);
  assert.match(consoleSource, /GitHub did not confirm the pull request/);
  assert.match(route, /requireMutationOrigin/);
  assert.match(route, /requireApiIdentity/);
  assert.match(route, /identity\.workspaceId/);
  assert.match(route, /finalizeMissionAgentPublication/);
  assert.doesNotMatch(route, /requestPublishForReview|recordPublicationPush|createPublicationAssignment/);
  const executor = await readFile("application/action-executor.ts", "utf8");
  assert.match(executor, /classification: "provider_verification_failure"/);
  assert.match(executor, /retryDisposition: "requires-human-review"/);
});

test("mission archive presents unknown cost as an explicit filter instead of a bare checkbox", async () => {
  const missionsPage = await readFile("app/missions/page.tsx", "utf8");
  assert.match(missionsPage, /Cost\s*<select name="unknownCost"/);
  assert.match(missionsPage, /<option value="true">Unknown cost<\/option>/);
  assert.doesNotMatch(missionsPage, /type="checkbox" name="unknownCost"/);
  assert.match(missionsPage, /hasUnknownCost: query\.unknownCost === "true"/);
});
