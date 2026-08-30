import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { routeMission } from "../v2/routing/router.ts";

const fixture = JSON.parse(await readFile(new URL("../fixtures/v2/agent-payment-risk-check.json", import.meta.url)));
const constitution = fixture.constitution;
const original = fixture.mission;

const report = (revision) => ({
  schema: "mc.engineer-report/v1",
  missionId: original.missionId,
  revision,
  outcome: "COMPLETED",
  summary: "The required ACP challenge field was missing.",
  evidence: [{ kind: "test", ref: "auth-agent:test", result: "PASS" }],
  risks: [],
  blockedOn: [],
  capabilitiesRequested: [],
});

test("routes an Engineer report to the configured Architect interface", () => {
  const result = routeMission({ constitution, mission: original, signal: report(2), lastProcessedRevision: 1 });
  assert.equal(result.mission.state, "ARCHITECT_REVIEW");
  assert.deepEqual(result.dispatch, {
    actor: "ARCHITECT",
    channel: "CHATGPT",
    adapter: "fake-architect",
    reason: "ENGINEER_REPORT_READY",
    idempotencyKey: "aprc-400:2:architect",
  });
});

test("routes Architect remediation to the configured Engineer interface", () => {
  const reviewing = { ...original, revision: 2, state: "ARCHITECT_REVIEW", currentActor: "ARCHITECT" };
  const result = routeMission({
    constitution,
    mission: reviewing,
    lastProcessedRevision: 2,
    signal: {
      schema: "mc.architect-decision/v1",
      missionId: original.missionId,
      revision: 3,
      decision: "REMEDIATE",
      rationale: "Retry behavior still needs coverage.",
      nextMission: {
        objective: "Add retry and malformed-challenge coverage.",
        acceptanceCriteria: ["New regression tests pass"],
        constraints: ["No external signing"],
      },
    },
  });
  assert.equal(result.mission.state, "ENGINEER_WORKING");
  assert.equal(result.mission.objective, "Add retry and malformed-challenge coverage.");
  assert.equal(result.dispatch?.actor, "ENGINEER");
  assert.equal(result.dispatch?.reason, "REMEDIATION");
});

test("waits for a separate CTO request and accepts only CTO-owned capabilities", () => {
  const reviewing = { ...original, revision: 4, state: "ARCHITECT_REVIEW", currentActor: "ARCHITECT" };
  const decision = {
    schema: "mc.architect-decision/v1",
    missionId: original.missionId,
    revision: 5,
    decision: "CTO_REQUIRED",
    rationale: "ACP authentication now requires a wallet signature.",
    nextMission: null,
  };
  const pending = routeMission({ constitution, mission: reviewing, signal: decision, lastProcessedRevision: 4 });
  assert.equal(pending.outcome, "WAITING");
  assert.equal(pending.mission.state, "ARCHITECT_REVIEW");
  assert.equal(pending.dispatch, undefined);

  const request = {
    schema: "mc.cto-request/v1",
    missionId: original.missionId,
    revision: 6,
    capability: "SIGN_WALLET_MESSAGE",
    action: "Approve ACP authentication signature",
    financialEffect: "$0",
    externalEffect: "Authentication signature only",
    reversible: true,
    architectRecommendation: "APPROVE",
    evidence: [{ kind: "engineer-report", revision: 4 }],
    status: "PENDING",
  };
  const result = routeMission({
    constitution,
    mission: pending.mission,
    signal: request,
    lastProcessedRevision: 5,
    pendingArchitectDecisionRevision: 5,
  });
  assert.equal(result.outcome, "WAITING");
  assert.equal(result.mission.state, "CTO_DECISION");
  assert.equal(result.dispatch, undefined);

  assert.throws(
    () =>
      routeMission({
        constitution,
        mission: pending.mission,
        lastProcessedRevision: 5,
        pendingArchitectDecisionRevision: 5,
        signal: { ...request, capability: "CODE_WRITE" },
      }),
    /does not require CTO authority/,
  );
});

test("routes CTO approval to Engineer and Discuss to ChatGPT", () => {
  const waiting = { ...original, revision: 5, state: "CTO_DECISION", currentActor: "CTO" };
  const approved = routeMission({
    constitution,
    mission: waiting,
    lastProcessedRevision: 5,
    pendingCtoRequestRevision: 5,
    signal: {
      schema: "mc.cto-decision/v1",
      missionId: original.missionId,
      revision: 6,
      requestRevision: 5,
      decision: "APPROVED",
    },
  });
  assert.equal(approved.dispatch?.actor, "ENGINEER");
  assert.equal(approved.dispatch?.reason, "CTO_APPROVED");

  const discuss = routeMission({
    constitution,
    mission: waiting,
    lastProcessedRevision: 5,
    pendingCtoRequestRevision: 5,
    signal: {
      schema: "mc.cto-decision/v1",
      missionId: original.missionId,
      revision: 6,
      requestRevision: 5,
      decision: "DISCUSS",
      comment: "Clarify what bytes will be signed.",
    },
  });
  assert.deepEqual(discuss.dispatch, {
    actor: "ARCHITECT",
    channel: "CHATGPT",
    adapter: "fake-architect",
    reason: "CTO_DISCUSS",
    idempotencyKey: "aprc-400:6:architect",
  });
});

test("ignores duplicate revisions and rejects gaps, stale CTO decisions, and invalid transitions", () => {
  const duplicate = routeMission({ constitution, mission: original, signal: report(1), lastProcessedRevision: 1 });
  assert.equal(duplicate.outcome, "DUPLICATE");
  assert.throws(
    () => routeMission({ constitution, mission: original, signal: report(3), lastProcessedRevision: 1 }),
    /not the next mission revision/,
  );
  assert.throws(
    () =>
      routeMission({
        constitution,
        mission: { ...original, revision: 5, state: "CTO_DECISION", currentActor: "CTO" },
        lastProcessedRevision: 5,
        pendingCtoRequestRevision: 5,
        signal: {
          schema: "mc.cto-decision/v1",
          missionId: original.missionId,
          revision: 6,
          requestRevision: 4,
          decision: "APPROVED",
        },
      }),
    /does not bind the pending request revision/,
  );
  assert.throws(
    () =>
      routeMission({
        constitution,
        mission: { ...original, state: "ARCHITECT_REVIEW", currentActor: "ARCHITECT" },
        signal: report(2),
        lastProcessedRevision: 1,
      }),
    /Invalid signal/,
  );
});

test("Architect approval completes the mission without dispatch", () => {
  const reviewing = { ...original, revision: 2, state: "ARCHITECT_REVIEW", currentActor: "ARCHITECT" };
  const result = routeMission({
    constitution,
    mission: reviewing,
    lastProcessedRevision: 2,
    signal: {
      schema: "mc.architect-decision/v1",
      missionId: original.missionId,
      revision: 3,
      decision: "APPROVE",
      rationale: "Acceptance criteria are satisfied.",
      nextMission: null,
    },
  });
  assert.equal(result.outcome, "COMPLETE");
  assert.equal(result.mission.currentActor, "NONE");
  assert.equal(result.dispatch, undefined);
});

test("owner reconciliation reopens only the exact blocked revision for Architect reassessment", () => {
  const blocked = { ...original, revision: 5, state: "BLOCKED_EXTERNAL", currentActor: "EXTERNAL" };
  const signal = {
    schema: "mc.owner-reconciliation/v1",
    missionId: original.missionId,
    revision: 6,
    blockedRevision: 5,
    reason: "The recovery release is now deployed and verified.",
    evidence: [{ kind: "deployment", ref: "commit:55e8bba", result: "production ready" }],
  };
  const result = routeMission({ constitution, mission: blocked, signal, lastProcessedRevision: 5 });
  assert.equal(result.mission.state, "ARCHITECT_REVIEW");
  assert.equal(result.mission.currentActor, "ARCHITECT");
  assert.deepEqual(result.dispatch, {
    actor: "ARCHITECT",
    channel: "CHATGPT",
    adapter: "fake-architect",
    reason: "OWNER_RECONCILIATION",
    idempotencyKey: "aprc-400:6:architect",
  });
  assert.throws(
    () =>
      routeMission({
        constitution,
        mission: blocked,
        signal: { ...signal, blockedRevision: 4 },
        lastProcessedRevision: 5,
      }),
    /does not bind the current blocked revision/,
  );
  assert.throws(
    () =>
      routeMission({
        constitution,
        mission: original,
        signal: { ...signal, revision: 2, blockedRevision: 1 },
        lastProcessedRevision: 1,
      }),
    /Invalid signal/,
  );
});
