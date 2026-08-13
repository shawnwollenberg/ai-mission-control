import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  decideMissionAgentGenerationTermination,
  missionAgentGenerationExitDisposition,
} from "../application/execution-commands.ts";
import { observeGovernedExecutionTerminal } from "../lib/acceptance-execution-observer.ts";

const hex = (character) => character.repeat(64);
const input = (overrides = {}) => ({
  actor: { workspaceId: "00000000-0000-4000-8000-000000000001", id: "launcher", type: "system" },
  commandId: "lifecycle-command",
  executionId: "00000000-0000-4000-8000-000000000002",
  assignmentId: "00000000-0000-4000-8000-000000000003",
  assignmentAttempt: 1,
  leaseReceiptId: "00000000-0000-4000-8000-000000000004",
  leaseTokenFingerprint: hex("a"),
  leaseOwner: "mission-agent-owner",
  fencingToken: 7,
  invocationId: "00000000-0000-4000-8000-000000000005",
  registeredProcessIdentitySha256: hex("b"),
  observedProcessIdentitySha256: hex("b"),
  expectedVersion: 27,
  exitCode: 0,
  terminationSignal: null,
  diagnosticIdentitySha256: hex("c"),
  ...overrides,
});
const authority = (overrides = {}) => ({
  status: "running",
  failure_classification: null,
  aggregate_version: 27,
  mission_id: "00000000-0000-4000-8000-000000000006",
  task_id: "00000000-0000-4000-8000-000000000007",
  assignment_id: input().assignmentId,
  attempt: 1,
  assignment_status: "acknowledged",
  lease_receipt_id: input().leaseReceiptId,
  lease_token_fingerprint: input().leaseTokenFingerprint,
  lease_owner: input().leaseOwner,
  fencing_token: 7,
  ...overrides,
});

test("launcher decision fails only the exact still-current nonterminal generation", () => {
  assert.equal(decideMissionAgentGenerationTermination(input(), authority()), "fail");
  for (const status of ["succeeded", "failed", "timed_out", "cancelled"])
    assert.equal(decideMissionAgentGenerationTermination(input(), authority({ status })), "already_terminal");
  for (const changed of [
    { attempt: 2 },
    { lease_receipt_id: "00000000-0000-4000-8000-000000000099" },
    { lease_token_fingerprint: hex("d") },
    { lease_owner: "replacement-owner" },
    { fencing_token: 8 },
  ])
    assert.equal(decideMissionAgentGenerationTermination(input(), authority(changed)), "authority_replaced");
});

test("launcher decision rejects ambiguous identity, stale versions, and inactive assignment authority", () => {
  assert.throws(
    () => decideMissionAgentGenerationTermination(input({ observedProcessIdentitySha256: hex("d") }), authority()),
    /process identity is invalid/,
  );
  assert.throws(
    () => decideMissionAgentGenerationTermination(input(), authority({ aggregate_version: 26 })),
    /aggregate version regressed/,
  );
  assert.throws(
    () => decideMissionAgentGenerationTermination(input(), authority({ assignment_status: "available" })),
    /not actively governed/,
  );
  assert.throws(
    () => decideMissionAgentGenerationTermination(input(), authority({ assignment_id: "changed" })),
    /assignment identity changed/,
  );
});

test("authorized successor dominates stale-generation timeout and exit outcomes", () => {
  assert.equal(
    missionAgentGenerationExitDisposition({
      authorityReplaced: true,
      timedOut: true,
      exitCode: null,
      expectedExit: false,
    }),
    "authorized_successor",
  );
  assert.equal(
    missionAgentGenerationExitDisposition({
      authorityReplaced: false,
      timedOut: true,
      exitCode: null,
      expectedExit: false,
    }),
    "timeout",
  );
  assert.equal(
    missionAgentGenerationExitDisposition({
      authorityReplaced: false,
      timedOut: false,
      exitCode: 1,
      expectedExit: false,
    }),
    "failed_exit",
  );
});

test("exact authority-scenario lifecycle contradiction reaches canonical failed before the one-hour deadline", async () => {
  let now = 1_000;
  let observation = {
    workspaceId: input().actor.workspaceId,
    missionId: authority().mission_id,
    childMissionId: authority().mission_id,
    executionId: input().executionId,
    assignmentId: input().assignmentId,
    assignmentAttempt: 1,
    leaseReceiptId: input().leaseReceiptId,
    leaseIdentity: hex("e"),
    fencingToken: 7,
    providerAttemptId: "1-1",
    status: "running",
    aggregateVersion: 27,
    projectionEventPosition: 27,
    latestEventId: "authority-scenario-1",
    latestEventType: "execution.progress_reported",
    latestEventAggregateVersion: 27,
    timeoutAt: new Date(now + 3_600_000),
    assignmentStatus: "acknowledged",
    pendingValidationCount: 0,
    validationReceiptCount: 0,
    implementationArtifactCount: 2,
  };
  const observed = observeGovernedExecutionTerminal({
    initial: observation,
    expectedTerminal: "failed",
    now: () => now,
    wait: async () => {
      now += 25;
      assert.equal(decideMissionAgentGenerationTermination(input(), authority()), "fail");
      observation = {
        ...observation,
        status: "failed",
        aggregateVersion: 28,
        projectionEventPosition: 28,
        latestEventId: "launcher-lifecycle-failure",
        latestEventType: "execution.failed",
        latestEventAggregateVersion: 28,
        assignmentStatus: "completed",
      };
    },
    read: async () => observation,
  });
  assert.equal((await observed).observation.status, "failed");
  assert.equal((await observed).elapsedMilliseconds, 25);
});

test("Mission Agent terminal callback is mandatory and the execution observer remains read-only", () => {
  const missionAgent = readFileSync(new URL("../scripts/mission-agent-080.template.mjs", import.meta.url), "utf8");
  const harness = readFileSync(new URL("../scripts/run-consensus-real-acceptance.ts", import.meta.url), "utf8");
  const observer = readFileSync(new URL("../lib/acceptance-execution-observer.ts", import.meta.url), "utf8");
  assert.doesNotMatch(
    missionAgent,
    /protocolMessage\(config, assignment, "ExecutionFailed",[\s\S]{0,500}\.catch\(\(\) => undefined\)/,
  );
  assert.match(missionAgent, /Governed ExecutionFailed delivery was not acknowledged/);
  assert.match(missionAgent, /terminalFailureDiagnostic/);
  assert.match(harness, /handleMissionAgentGenerationTermination/);
  assert.match(harness, /waitForLifecycleTerminal/);
  assert.match(harness, /row\.lease_owner === expectedLeaseOwner/);
  assert.match(harness, /MISSION_AGENT_LEASE_OWNER_OVERRIDE: expectedLeaseOwner/);
  assert.match(harness, /authorizedSuccessorObserved: authorityReplaced/);
  assert.match(harness, /authorityReplaced[\s\S]{0,200}\? \{ status: replacementReconciliation\.status/);
  assert.match(missionAgent, /MISSION_AGENT_LEASE_OWNER_OVERRIDE/);
  assert.match(missionAgent, /config = withAcceptanceLeaseOwner\(await loadConfig\(\)\)/);
  assert.match(harness, /reconciliation\?\.disposition === "authority_replaced"/);
  assert.doesNotMatch(observer, /handleExecutionTransition|handleMissionAgentGenerationTermination|appendEvents/);
});

test("lifecycle consequence repair is retryable after the execution transition commits", () => {
  const commands = readFileSync(new URL("../application/execution-commands.ts", import.meta.url), "utf8");
  assert.match(
    commands,
    /failure_classification === "mission_agent_generation_terminated"[\s\S]{0,120}finalizeMissionAgentLifecycleFailure/,
  );
  assert.match(commands, /await finalizeMissionAgentLifecycleFailure\(input, authority\)/);
  assert.match(commands, /verified\.assignment_status !== "completed"/);
  assert.match(commands, /verified\.lease_token_hash !== null/);
  assert.doesNotMatch(commands, /try \{[\s\S]{0,2500}coordinateAfterTask[\s\S]{0,300}catch \(error\)/);
});
