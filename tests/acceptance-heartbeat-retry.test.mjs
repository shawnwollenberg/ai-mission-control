import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../scripts/run-consensus-real-acceptance.ts", import.meta.url), "utf8");
const messageSource = readFileSync(new URL("../application/remote-agent-messages.ts", import.meta.url), "utf8");
const {
  artifactPresentationVerificationMarker,
  latestArtifactPresentationMatches,
  matchesArtifactPresentationVerificationMarker,
} = await import("../application/remote-agent-messages.ts");
const match = source.match(/export function retryableAcceptanceHeartbeatFailure\([\s\S]*?\n\) \{([\s\S]*?)\n\}/);
assert.ok(match, "production heartbeat retry classifier must remain extractable");
const retryableAcceptanceHeartbeatFailure = Function("code", "signal", "stdout", "stderr", "attempt", match[1]);

test("authenticated harness retries only bounded client heartbeat timeouts", () => {
  const timeout = "Mission Agent: The operation was aborted due to timeout\n";
  assert.equal(retryableAcceptanceHeartbeatFailure(1, null, "", timeout, 1), true);
  assert.equal(retryableAcceptanceHeartbeatFailure(1, null, "", `${timeout}${timeout}`, 2), true);
  assert.equal(retryableAcceptanceHeartbeatFailure(1, null, "", timeout, 3), false);
  assert.equal(
    retryableAcceptanceHeartbeatFailure(1, null, "", `HTTP 401 authentication failed\n${timeout}`, 1),
    false,
  );
  assert.equal(retryableAcceptanceHeartbeatFailure(1, null, "", `lease lost\n${timeout}`, 1), false);
  assert.equal(retryableAcceptanceHeartbeatFailure(1, null, "unexpected stdout", timeout, 1), false);
  assert.equal(retryableAcceptanceHeartbeatFailure(null, "SIGTERM", "", timeout, 1), false);
  assert.equal(retryableAcceptanceHeartbeatFailure(2, null, "", timeout, 1), false);
  assert.match(source, /for \(let attempt = 1; attempt <= 3; attempt \+= 1\)/);
  assert.match(source, /heartbeat failed after \$\{attempt\} attempt\(s\)/);
  assert.match(source, /for \(const agent of agents\) await runHeartbeat\(agent\)/);
  assert.doesNotMatch(source, /Promise\.all\(agents\.map\(\(agent\) => runHeartbeat\(agent\)\)\)/);
  assert.match(source, /maintainIdleAgentHeartbeats = true/);
  assert.match(source, /\.\.\.\(maintainIdleAgentHeartbeats \? agents : \[\]\)/);
  assert.match(source, /return runAvailableAgents\(agents, false\)/);
});

test("heartbeat append cost is bounded by the aggregate head", () => {
  const branch = messageSource.match(
    /if \(message\.messageType === "AgentHeartbeat"[\s\S]*?return \{ status: "accepted"/,
  )?.[0];
  assert.ok(branch, "heartbeat handler branch must remain extractable");
  assert.match(branch, /loadAggregateHead\(\{/);
  assert.match(branch, /expectedVersion: aggregateHead\.version/);
  assert.match(branch, /causationId: aggregateHead\.eventId \?\? undefined/);
  assert.doesNotMatch(branch, /loadAggregateEvents\(\{/);
  assert.match(branch, /event_type='agent\.artifact_presentation_verified'/);
  assert.match(branch, /ORDER BY aggregate_version DESC[\s\S]*LIMIT 1/);
  assert.match(branch, /latestArtifactPresentationMatches\(/);
  assert.match(branch, /artifactVerification\.status === "verified"/);
  assert.match(branch, /eventType: "agent\.artifact_presentation_verified"/);
  assert.match(branch, /disposablePacket: hasPriorArtifactPresentation \? undefined/);
  assert.match(
    branch,
    /WHEN \$17::jsonb IS NULL THEN mission_agent_disposable_packet[\s\S]*!hasPriorArtifactPresentation && artifactVerification\.disposablePacket/,
  );
  assert.doesNotMatch(branch, /!credentialVerified && message\.payload\.artifact/);
});

test("artifact presentation markers bind exact durable trust identity", () => {
  const binding = {
    schemaVersion: "artifact-presentation-verified/1",
    artifact: "a".repeat(64),
    runtime: "b".repeat(64),
  };
  const marker = artifactPresentationVerificationMarker(binding, "12345678-1234-4234-8234-123456789abc");
  assert.equal(matchesArtifactPresentationVerificationMarker(marker, binding), true);
  for (const changed of [
    { ...binding, artifact: "c".repeat(64) },
    { ...binding, runtime: "d".repeat(64) },
  ])
    assert.equal(matchesArtifactPresentationVerificationMarker(marker, changed), false);
  assert.equal(matchesArtifactPresentationVerificationMarker({ ...marker, extra: true }, binding), false);
  assert.equal(matchesArtifactPresentationVerificationMarker({ ...marker, identity: "0".repeat(64) }, binding), false);
  const missing = { ...marker };
  delete missing.binding;
  assert.equal(matchesArtifactPresentationVerificationMarker(missing, binding), false);

  const changedBinding = { ...binding, artifact: "c".repeat(64) };
  const changedMarker = artifactPresentationVerificationMarker(changedBinding, "12345678-1234-4234-8234-123456789abd");
  assert.equal(latestArtifactPresentationMatches([marker], binding), true);
  assert.equal(latestArtifactPresentationMatches([changedMarker, marker], binding), false);
  assert.equal(latestArtifactPresentationMatches([marker, changedMarker], binding), true);
});
