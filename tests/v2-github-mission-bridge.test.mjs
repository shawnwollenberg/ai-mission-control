import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { GitHubIssueMissionStore } from "../v2/github/github-issue-store.ts";
import { parseMachineComment, renderEnvelope, renderMissionBody } from "../v2/github/protocol.ts";
import { reconcileGitHubMission } from "../v2/github/reconciliation.ts";

const fixture = JSON.parse(await readFile(new URL("../fixtures/v2/agent-payment-risk-check.json", import.meta.url)));
const constitution = fixture.constitution;
const initialMission = fixture.mission;
const authorizedLogins = ["mission-control-test"];

class MemoryIssueApi {
  nextCommentId = 1;
  issue = {
    number: 42,
    url: "https://github.com/example/test/issues/42",
    title: "[Mission][TEST] Resolve /auth/agent HTTP 400",
    body: renderMissionBody(initialMission),
    state: "open",
    stateReason: null,
    labels: ["mc:mission", "mc:engineer-working"],
    authorLogin: "mission-control-test",
    comments: [],
  };

  async readIssue() {
    return structuredClone(this.issue);
  }

  async addComment(_issueNumber, body) {
    this.issue.comments.push({
      id: this.nextCommentId++,
      body,
      authorLogin: "mission-control-test",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
  }

  async updateIssue(_issueNumber, input) {
    if (input.labels) this.issue.labels = [...input.labels];
    if (input.state) {
      this.issue.state = input.state;
      this.issue.stateReason = input.state === "closed" ? "completed" : "reopened";
    }
  }
}

const engineerReport = (revision, summary = "The required ACP challenge field was missing.") => ({
  schema: "mc.engineer-report/v1",
  missionId: initialMission.missionId,
  revision,
  outcome: "COMPLETED",
  summary,
  evidence: [{ kind: "test", ref: `auth-agent:test:${revision}`, result: "PASS" }],
  risks: [],
  blockedOn: [],
  capabilitiesRequested: [],
});

const architectDecision = (revision, decision, nextMission = null) => ({
  schema: "mc.architect-decision/v1",
  missionId: initialMission.missionId,
  revision,
  decision,
  rationale: `Architect selected ${decision}.`,
  nextMission,
});

test("reconstructs the complete acceptance lifecycle from one GitHub Issue", async () => {
  const api = new MemoryIssueApi();
  const store = new GitHubIssueMissionStore(api, { constitution, authorizedLogins });
  const ref = { issueNumber: 42 };

  assert.equal((await store.appendEngineerReport(ref, engineerReport(2))).mission.state, "ARCHITECT_REVIEW");
  assert.equal(
    (
      await store.appendArchitectDecision(
        ref,
        architectDecision(3, "REMEDIATE", {
          objective: "Add retry and malformed-challenge coverage.",
          acceptanceCriteria: ["Regression tests pass"],
          constraints: ["No external signing"],
        }),
      )
    ).mission.state,
    "ENGINEER_WORKING",
  );
  assert.equal((await store.appendEngineerReport(ref, engineerReport(4))).mission.state, "ARCHITECT_REVIEW");
  assert.equal(
    (await store.appendArchitectDecision(ref, architectDecision(5, "CTO_REQUIRED"))).mission.state,
    "ARCHITECT_REVIEW",
  );
  assert.equal(
    (
      await store.appendCtoRequest(ref, {
        schema: "mc.cto-request/v1",
        missionId: initialMission.missionId,
        revision: 6,
        capability: "SIGN_WALLET_MESSAGE",
        action: "Approve ACP authentication signature",
        financialEffect: "$0",
        externalEffect: "Authentication signature only",
        reversible: true,
        architectRecommendation: "APPROVE",
        evidence: [{ kind: "engineer-report", revision: 4 }],
        status: "PENDING",
      })
    ).mission.state,
    "CTO_DECISION",
  );
  assert.equal(
    (
      await store.appendCtoDecision(ref, {
        schema: "mc.cto-decision/v1",
        missionId: initialMission.missionId,
        revision: 7,
        requestRevision: 6,
        decision: "APPROVED",
      })
    ).mission.state,
    "ENGINEER_WORKING",
  );
  await store.appendEngineerReport(ref, engineerReport(8));
  const completedOpen = await store.appendArchitectDecision(ref, architectDecision(9, "APPROVE"));
  assert.equal(completedOpen.mission.state, "COMPLETE");
  assert.equal(completedOpen.complete, false);
  const completed = await store.closeMission(ref);
  assert.equal(completed.complete, true);
  assert.equal(completed.latestRevision, 9);

  const rebuilt = await new GitHubIssueMissionStore(api, { constitution, authorizedLogins }).reconcileMission(ref);
  assert.equal(rebuilt.historyDigest, completed.historyDigest);
  assert.deepEqual(rebuilt.mission, completed.mission);
  assert.equal(rebuilt.latestEngineerReport?.revision, 8);
  assert.equal(rebuilt.latestArchitectDecision?.revision, 9);
  assert.equal(rebuilt.pendingCtoRequest, undefined);
});

test("ordinary human comments remain readable and cannot alter machine state", () => {
  const api = new MemoryIssueApi();
  api.issue.comments.push({
    id: 99,
    body: "Could we explain the challenge bytes before signing?",
    authorLogin: "human-reviewer",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  });
  const result = reconcileGitHubMission({ constitution, issue: api.issue, authorizedLogins });
  assert.deepEqual(result.ignoredHumanCommentIds, [99]);
  assert.equal(result.latestRevision, 1);
});

test("owner reconciliation is canonical, revision-bound, and reconstructs an Architect route", async () => {
  const api = new MemoryIssueApi();
  const store = new GitHubIssueMissionStore(api, { constitution, authorizedLogins });
  const ref = { issueNumber: 42 };
  await store.appendEngineerReport(ref, engineerReport(2));
  await store.appendArchitectDecision(ref, architectDecision(3, "BLOCKED_EXTERNAL"));
  const reopened = await store.appendOwnerReconciliation(ref, {
    schema: "mc.owner-reconciliation/v1",
    missionId: initialMission.missionId,
    revision: 4,
    blockedRevision: 3,
    reason: "New deployment evidence is available.",
    evidence: [{ kind: "deployment", ref: "digest:abc", result: "healthy" }],
  });
  assert.equal(reopened.mission.state, "ARCHITECT_REVIEW");
  assert.equal(reopened.latestOwnerReconciliation?.blockedRevision, 3);
  assert.deepEqual(api.issue.labels, ["mc:mission", "mc:architect-review"]);
  const rebuilt = reconcileGitHubMission({ constitution, issue: api.issue, authorizedLogins });
  assert.equal(rebuilt.latestRevision, 4);
  assert.equal(rebuilt.latestOwnerReconciliation?.reason, "New deployment evidence is available.");
});

test("owner Mission amendment preserves history and reconstructs replacement criteria", async () => {
  const api = new MemoryIssueApi();
  const store = new GitHubIssueMissionStore(api, { constitution, authorizedLogins });
  const ref = { issueNumber: 42 };
  await store.appendEngineerReport(ref, engineerReport(2));
  await store.appendArchitectDecision(ref, architectDecision(3, "BLOCKED_EXTERNAL"));
  const originalCriteria = [...initialMission.acceptanceCriteria];
  const replacementAcceptanceCriteria = [
    "Current canonical Mission state is projected truthfully",
    "Historical failed dispatch evidence remains preserved",
  ];
  const amended = await store.appendOwnerMissionAmendment(ref, {
    schema: "mc.owner-mission-amendment/v1",
    missionId: initialMission.missionId,
    revision: 4,
    blockedRevision: 3,
    reason: "The old dashboard criterion references a superseded revision.",
    replacementAcceptanceCriteria,
    evidence: [{ kind: "owner-scope-decision", ref: "issue-38:revision-15" }],
  });
  assert.equal(amended.mission.state, "ARCHITECT_REVIEW");
  assert.deepEqual(amended.mission.acceptanceCriteria, replacementAcceptanceCriteria);
  assert.deepEqual(initialMission.acceptanceCriteria, originalCriteria);
  assert.equal(amended.latestOwnerMissionAmendment?.blockedRevision, 3);
  assert.deepEqual(api.issue.labels, ["mc:mission", "mc:architect-review"]);
  const comment = api.issue.comments.at(-1).body;
  assert.match(comment, /mission-control:owner-mission-amendment:start/);
  const rebuilt = reconcileGitHubMission({ constitution, issue: api.issue, authorizedLogins });
  assert.equal(rebuilt.latestRevision, 4);
  assert.deepEqual(rebuilt.mission.acceptanceCriteria, replacementAcceptanceCriteria);
  assert.equal(
    rebuilt.latestOwnerMissionAmendment?.reason,
    "The old dashboard criterion references a superseded revision.",
  );
});

test("duplicate delivery is idempotent, out-of-order comments reconcile by revision, and conflicts fail", () => {
  const api = new MemoryIssueApi();
  const report = engineerReport(2);
  const decision = architectDecision(3, "REMEDIATE", {
    objective: "Add retry coverage.",
    acceptanceCriteria: ["Retry tests pass"],
    constraints: [],
  });
  api.issue.comments.push(
    {
      id: 2,
      body: renderEnvelope("architect-decision", decision),
      authorLogin: "mission-control-test",
      createdAt: new Date(1).toISOString(),
      updatedAt: new Date(1).toISOString(),
    },
    {
      id: 1,
      body: renderEnvelope("engineer-report", report),
      authorLogin: "mission-control-test",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
    {
      id: 3,
      body: renderEnvelope("engineer-report", report),
      authorLogin: "mission-control-test",
      createdAt: new Date(2).toISOString(),
      updatedAt: new Date(2).toISOString(),
    },
  );
  api.issue.labels = ["mc:mission", "mc:engineer-working"];
  assert.equal(reconcileGitHubMission({ constitution, issue: api.issue, authorizedLogins }).latestRevision, 3);

  api.issue.comments.push({
    id: 4,
    body: renderEnvelope("engineer-report", engineerReport(2, "Conflicting edited content")),
    authorLogin: "mission-control-test",
    createdAt: new Date(3).toISOString(),
    updatedAt: new Date(3).toISOString(),
  });
  assert.throws(
    () => reconcileGitHubMission({ constitution, issue: api.issue, authorizedLogins }),
    /Conflicting duplicate revision 2/,
  );
});

test("rejects malformed, unknown, unauthorized, gapped, stale, and state-invalid envelopes", () => {
  assert.throws(
    () =>
      parseMachineComment(
        "<!-- mission-control:engineer-report:start -->\n{bad}\n<!-- mission-control:engineer-report:end -->",
      ),
    /malformed JSON/,
  );
  assert.throws(
    () =>
      parseMachineComment(
        '<!-- mission-control:engineer-report:start -->\n{"schema":"mc.engineer-report/v2"}\n<!-- mission-control:engineer-report:end -->',
      ),
    /Unknown machine envelope schema/,
  );

  const unauthorized = new MemoryIssueApi();
  unauthorized.issue.comments.push({
    id: 1,
    body: renderEnvelope("engineer-report", engineerReport(2)),
    authorLogin: "untrusted-user",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  });
  assert.throws(
    () => reconcileGitHubMission({ constitution, issue: unauthorized.issue, authorizedLogins }),
    /unauthorized author/,
  );

  const gap = new MemoryIssueApi();
  gap.issue.comments.push({
    id: 1,
    body: renderEnvelope("engineer-report", engineerReport(3)),
    authorLogin: "mission-control-test",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  });
  assert.throws(() => reconcileGitHubMission({ constitution, issue: gap.issue, authorizedLogins }), /Revision gap/);

  const invalid = new MemoryIssueApi();
  invalid.issue.comments.push({
    id: 1,
    body: renderEnvelope("cto-decision", {
      schema: "mc.cto-decision/v1",
      missionId: initialMission.missionId,
      revision: 2,
      requestRevision: 1,
      decision: "APPROVED",
    }),
    authorLogin: "mission-control-test",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  });
  assert.throws(
    () => reconcileGitHubMission({ constitution, issue: invalid.issue, authorizedLogins }),
    /Invalid signal/,
  );
});

test("unexpected closure and reopening fail closed", async () => {
  const closedEarly = new MemoryIssueApi();
  closedEarly.issue.state = "closed";
  closedEarly.issue.stateReason = "completed";
  assert.throws(
    () => reconcileGitHubMission({ constitution, issue: closedEarly.issue, authorizedLogins }),
    /closed unexpectedly/,
  );

  const api = new MemoryIssueApi();
  const store = new GitHubIssueMissionStore(api, { constitution, authorizedLogins });
  const ref = { issueNumber: 42 };
  await store.appendEngineerReport(ref, engineerReport(2));
  await store.appendArchitectDecision(ref, architectDecision(3, "APPROVE"));
  await store.closeMission(ref);
  await api.updateIssue(42, { state: "open" });
  await assert.rejects(() => store.reconcileMission(ref), /reopened/);
});
