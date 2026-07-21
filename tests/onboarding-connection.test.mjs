import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { connectionProgress } from "../app/onboarding/connection-progress.ts";

const connection = { agentId: "agent-1", agentName: "Shawn's Computer – Codex", command: "secret" };

test("onboarding requires heartbeat, pull readiness, and a repository", () => {
  assert.deepEqual(connectionProgress(Boolean(connection), undefined), {
    generated: true,
    installed: false,
    heartbeat: false,
    pullReady: false,
    repository: false,
  });
  assert.equal(
    Object.values(connectionProgress(Boolean(connection), { last_heartbeat_at: "now" })).every(Boolean),
    false,
  );
  assert.equal(
    Object.values(
      connectionProgress(Boolean(connection), {
        mission_agent_version: "0.2.0",
        pull_ready_at: "now",
        repository_count: 1,
      }),
    ).every(Boolean),
    false,
  );
  assert.equal(
    Object.values(
      connectionProgress(Boolean(connection), {
        mission_agent_version: "0.2.0",
        last_heartbeat_at: "now",
        pull_ready_at: "now",
        repository_count: 0,
      }),
    ).every(Boolean),
    false,
  );
  assert.equal(
    Object.values(
      connectionProgress(Boolean(connection), {
        mission_agent_version: "0.2.0",
        last_heartbeat_at: "now",
        pull_ready_at: "now",
        repository_count: 1,
      }),
    ).every(Boolean),
    true,
  );
});

test("connection UI keeps the payload masked and advanced setup collapsed", async () => {
  const source = await readFile(new URL("../app/onboarding/wizard.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /secure one-time payload — use Copy/);
  assert.match(source, /connect '\[protected credential hidden\]'/);
  assert.match(source, /Advanced: connect a repository by absolute path/);
  assert.doesNotMatch(source, /<details className="connection-details" open>/);
  assert.match(source, /navigator\.clipboard\.writeText\(command\)/);
  assert.match(source, /Copy connection command/);
  assert.match(source, /navigator\.clipboard\.writeText\("mission-agent doctor"\)/);
  assert.match(source, /Still waiting\?/);
  assert.match(source, /mission-agent-command-list/);
  assert.match(source, /Check the connection, heartbeat, active assignment/);
  assert.match(source, /Add another Git repository/);
  assert.match(source, /Run connection and dependency diagnostics/);
  assert.match(
    source,
    /This page will advance automatically once Mission Agent is connected and ready to receive work\./,
  );
});

test("Mission Agent maintains pull readiness with periodic signed heartbeats", async () => {
  const manifest = JSON.parse(await readFile(new URL("../public/mission-agent-latest.json", import.meta.url), "utf8"));
  const source = await readFile(new URL(`../public${manifest.path}`, import.meta.url), "utf8");
  const connectRoute = await readFile(new URL("../app/api/onboarding/connect/route.ts", import.meta.url), "utf8");
  assert.match(connectRoute, new RegExp(`missionAgentVersion = "${manifest.version}"`));
  assert.match(connectRoute, new RegExp(`missionAgentChecksum = "${manifest.sha256}"`));
  assert.match(source, /const heartbeatTimer = setInterval/);
  assert.match(source, /60_000/);
  assert.match(source, /heartbeatTimer\.unref\(\)/);
  assert.match(source, /assignment\.instructions \?\? assignment\.taskObjective/);
});

test("live mission form makes analysis and change objectives explicit and editable", async () => {
  const source = await readFile(new URL("../app/first-mission-form.tsx", import.meta.url), "utf8");
  assert.match(source, /Analyze Repository/);
  assert.match(source, /Change Repository/);
  assert.match(source, /acceptanceCriteria/);
  assert.match(source, /validationInstructions/);
  assert.match(source, /setObjective/);
  assert.match(source, /No push, pull request, merge, deployment, or secrets/);
});

test("a user-named Codex Mission Agent is not mislabeled as Hermes", async () => {
  const source = await readFile("app/missions/[missionId]/durable-mission-console.tsx", "utf8");
  assert.match(source, /agentName\?\.toLocaleLowerCase\(\)\.includes\("codex"\)/);
  assert.doesNotMatch(source, /agentName === "Codex"/);
});

test("mission status feels live while remaining accessible and explicit", async () => {
  const source = await readFile("app/missions/[missionId]/durable-mission-console.tsx", "utf8");
  const styles = await readFile("app/globals.css", "utf8");
  assert.match(source, /status-symbol-running/);
  assert.match(source, /status-symbol-completed/);
  assert.match(source, /status-symbol-failed/);
  assert.match(source, /role="status"/);
  assert.match(source, /Mission status:/);
  assert.match(styles, /mission-status-pulse 1\.8s ease-in-out infinite/);
  assert.match(styles, /prefers-reduced-motion: reduce/);
});

test("recommendations expose traceable one-click Change Mission creation", async () => {
  const page = await readFile(new URL("../app/recommendations/[recommendationId]/page.tsx", import.meta.url), "utf8");
  const actions = await readFile(
    new URL("../app/recommendations/[recommendationId]/recommendation-actions.tsx", import.meta.url),
    "utf8",
  );
  const route = await readFile(
    new URL("../app/api/recommendations/[recommendationId]/change-mission/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(page, /Repository Recommendation/);
  assert.match(page, /Evidence/);
  assert.match(actions, /Create Change Mission/);
  assert.match(actions, /Retry Change Mission/);
  assert.match(actions, /Create Follow-up Change Mission/);
  assert.match(route, /retriableMissionStatuses/);
  assert.match(route, /sourceRecommendationId/);
  assert.match(route, /acceptanceCriteria/);
  assert.match(route, /suggestedValidation/);
});

test("repository preflight failures use actionable product language", async () => {
  const console = await readFile("app/missions/[missionId]/durable-mission-console.tsx", "utf8");
  assert.match(console, /Repository preflight blocked/);
  assert.match(console, /Execution heartbeat: Not expected/);
  assert.match(console, /stopped safely before Codex made changes/);
});

test("approval filters share one desktop row without clipping inbox messages", async () => {
  const page = await readFile("app/approvals/page.tsx", "utf8");
  const inbox = await readFile("app/approvals/inbox.tsx", "utf8");
  const styles = await readFile("app/globals.css", "utf8");
  assert.match(page, /approval-filter-bar/);
  assert.match(styles, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\) auto/);
  assert.match(inbox, /approval-inbox-list/);
  assert.match(styles, /\.approval-inbox-list \{[\s\S]*max-height: none/);
});

test("authenticated pages share one consistent primary navigation", async () => {
  const navigation = await readFile("app/app-navigation.tsx", "utf8");
  for (const label of ["New Mission", "Missions", "Agents", "Approvals", "Templates", "Operations", "Log out"])
    assert.match(navigation, new RegExp(label));
  for (const page of [
    "app/missions/page.tsx",
    "app/approvals/page.tsx",
    "app/agents/page.tsx",
    "app/templates/page.tsx",
    "app/operations/page.tsx",
    "app/schedules/page.tsx",
    "app/notifications/page.tsx",
  ])
    assert.match(await readFile(page, "utf8"), /<AppNavigation subtitle=/);
});
