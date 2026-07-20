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
  assert.match(source, /mission-control secure connect ••••••••••••/);
  assert.match(source, /Advanced: connect a repository by absolute path/);
  assert.doesNotMatch(source, /<details className="connection-details" open>/);
  assert.match(source, /navigator\.clipboard\.writeText\(command\)/);
  assert.match(source, /Still waiting for Mission Agent/);
  assert.match(
    source,
    /This page will advance automatically once Mission Agent is connected and ready to receive work\./,
  );
});
