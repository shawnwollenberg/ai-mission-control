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
  const source = await readFile(new URL("../public/mission-agent-0.2.3.mjs", import.meta.url), "utf8");
  assert.match(source, /const heartbeatTimer = setInterval/);
  assert.match(source, /60_000/);
  assert.match(source, /heartbeatTimer\.unref\(\)/);
  assert.match(source, /assignment\.instructions \?\? assignment\.taskObjective/);
});
