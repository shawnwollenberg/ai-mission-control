import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexSdkArchitectAdapter } from "../v2/adapters/codex-sdk-architect.ts";
import { GitHubIssueMissionStore } from "../v2/github/github-issue-store.ts";
import { renderMissionBody } from "../v2/github/protocol.ts";
import { MissionOrchestrator } from "../v2/orchestration/orchestrator.ts";
import { JsonBindingStore, MemoryBindingStore } from "../v2/runtime/bindings.ts";
import { loadV2Configuration } from "../v2/runtime/config.ts";
import { missionCard } from "../v2/ui/view-model.ts";
import { classifyProviderFailure } from "../v2/runtime/operational-errors.ts";

const fixture = JSON.parse(await readFile(new URL("../fixtures/v2/agent-payment-risk-check.json", import.meta.url)));
const constitution = { ...fixture.constitution, repository: "example/fixture" };
const project = {
  projectId: constitution.projectId,
  name: "Fixture",
  githubRepo: constitution.repository,
  localCheckout: "/tmp/fixture",
  repositoryUrl: `https://github.com/${constitution.repository}`,
  architectAdapter: "codex-sdk",
  engineerAdapter: "codex-sdk",
  active: true,
  constitution: {
    ...constitution,
    architect: { adapter: "codex-sdk", channel: "CHATGPT" },
    engineer: { adapter: "codex-sdk" },
  },
};

class MemoryIssueApi {
  constructor(mission = fixture.mission) {
    this.issue = {
      number: 42,
      url: "https://github.com/example/fixture/issues/42",
      title: "mission",
      body: renderMissionBody(mission),
      state: "open",
      stateReason: null,
      labels: ["mc:mission", "mc:engineer-working"],
      authorLogin: "owner",
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
      comments: [],
    };
    this.next = 1;
    this.loseNextCommentResponse = false;
  }
  async readIssue() {
    return structuredClone(this.issue);
  }
  async addComment(_number, body) {
    this.issue.comments.push({
      id: this.next++,
      body,
      authorLogin: "owner",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    if (this.loseNextCommentResponse) {
      this.loseNextCommentResponse = false;
      throw new Error("GitHub response lost after write");
    }
  }
  async updateIssue(_number, input) {
    if (input.labels) this.issue.labels = input.labels;
    if (input.state) {
      this.issue.state = input.state;
      this.issue.stateReason = input.state === "closed" ? "completed" : "reopened";
    }
  }
}

const completedReport = (mission) => ({
  schema: "mc.engineer-report/v1",
  missionId: mission.missionId,
  revision: mission.revision + 1,
  outcome: "COMPLETED",
  summary: "Bounded validation completed",
  evidence: [{ kind: "test", ref: "fixture", result: "PASS" }],
  risks: [],
  blockedOn: [],
  capabilitiesRequested: [],
});

test("restart commits a persisted provider result without dispatching a duplicate turn", async () => {
  const api = new MemoryIssueApi();
  const store = new GitHubIssueMissionStore(api, { constitution: project.constitution, authorizedLogins: ["owner"] });
  const bindings = new MemoryBindingStore();
  await bindings.put({
    missionId: fixture.mission.missionId,
    projectId: project.projectId,
    issueNumber: 42,
    lastProcessedRevision: 1,
    inFlight: {
      idempotencyKey: `${fixture.mission.missionId}:1:engineer`,
      actor: "ENGINEER",
      revision: 1,
      result: completedReport(fixture.mission),
      providerThreadId: "engineer-restart",
    },
  });
  const never = { run: async () => assert.fail("provider must not be redispatched") };
  const result = await new MissionOrchestrator(project, store, bindings, never, {}).advance(42);
  assert.equal(result.latestRevision, 2);
  assert.equal((await bindings.get(fixture.mission.missionId)).inFlight, undefined);
});

test("GitHub write success with a lost response repairs labels and does not duplicate provider work", async () => {
  const api = new MemoryIssueApi();
  api.loseNextCommentResponse = true;
  const store = new GitHubIssueMissionStore(api, { constitution: project.constitution, authorizedLogins: ["owner"] });
  const bindings = new MemoryBindingStore();
  let calls = 0;
  const engineer = {
    run: async ({ mission }) => {
      calls++;
      return { report: completedReport(mission), threadId: "engineer-lost-response" };
    },
  };
  await assert.rejects(
    () => new MissionOrchestrator(project, store, bindings, engineer, {}).advance(42),
    /response lost/,
  );
  const recovered = await new MissionOrchestrator(project, store, bindings, engineer, {}).advance(42);
  assert.equal(recovered.latestRevision, 2);
  assert.equal(calls, 1);
  assert.deepEqual(api.issue.labels, ["mc:mission", "mc:architect-review"]);
});

test("restart with an indeterminate provider call fails closed and exposes a bounded failure", async () => {
  const api = new MemoryIssueApi();
  const store = new GitHubIssueMissionStore(api, { constitution: project.constitution, authorizedLogins: ["owner"] });
  const bindings = new MemoryBindingStore();
  await bindings.put({
    missionId: fixture.mission.missionId,
    projectId: project.projectId,
    issueNumber: 42,
    lastProcessedRevision: 1,
    inFlight: { idempotencyKey: "indeterminate", actor: "ENGINEER", revision: 1 },
  });
  await assert.rejects(
    () => new MissionOrchestrator(project, store, bindings, {}, {}).advance(42),
    /outcome is indeterminate/,
  );
  assert.equal((await bindings.get(fixture.mission.missionId)).failure.code, "PROVIDER_DISPATCH_INDETERMINATE");
});

test("an edited source Mission envelope cannot commit an in-flight provider result", async () => {
  const api = new MemoryIssueApi();
  const store = new GitHubIssueMissionStore(api, { constitution: project.constitution, authorizedLogins: ["owner"] });
  const bindings = new MemoryBindingStore();
  const initial = await store.readMission({ issueNumber: 42 });
  await bindings.put({
    missionId: fixture.mission.missionId,
    projectId: project.projectId,
    issueNumber: 42,
    sourceMissionDigest: initial.sourceMissionDigest,
    lastProcessedRevision: 1,
    inFlight: {
      idempotencyKey: "edited",
      actor: "ENGINEER",
      revision: 1,
      result: completedReport(fixture.mission),
    },
  });
  api.issue.body = renderMissionBody({ ...fixture.mission, objective: "Silently expanded scope" });
  await assert.rejects(
    () => new MissionOrchestrator(project, store, bindings, {}, {}).advance(42),
    /Mission envelope changed/,
  );
  assert.equal(api.issue.comments.length, 0);
});

test("Architect approval guard rejects complete claims with failing evidence", async () => {
  const report = {
    ...completedReport(fixture.mission),
    evidence: [{ kind: "test", ref: "fixture", result: "FAILED" }],
  };
  const decision = {
    schema: "mc.architect-decision/v1",
    missionId: fixture.mission.missionId,
    revision: 2,
    decision: "APPROVE",
    rationale: "Trusted the claim",
    nextMission: null,
  };
  const thread = { id: "architect-adversarial", run: async () => ({ finalResponse: JSON.stringify(decision) }) };
  await assert.rejects(
    () =>
      new CodexSdkArchitectAdapter({ startThread: () => thread, resumeThread: () => thread }).review({
        mission: fixture.mission,
        constitution: project.constitution,
        engineerReport: report,
        localCheckout: "/tmp/fixture",
      }),
    /contradicts failing Engineer evidence/,
  );
});

test("three concurrent bindings remain isolated in one minimal JSON store", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mc-v2-concurrency-"));
  const path = join(directory, "bindings.json");
  try {
    await Promise.all(
      [1, 2, 3].map((value) =>
        new JsonBindingStore(path).update(`mission-${value}`, () => ({
          missionId: `mission-${value}`,
          projectId: `project-${value}`,
          issueNumber: value,
          codexThreadId: `engineer-${value}`,
          architectThreadId: `architect-${value}`,
          lastProcessedRevision: value,
        })),
      ),
    );
    const values = await new JsonBindingStore(path).list();
    assert.equal(values.length, 3);
    assert.equal(new Set(values.flatMap((value) => [value.codexThreadId, value.architectThreadId])).size, 6);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("configuration rejects adapter drift and duplicate tracked Issues", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mc-v2-config-"));
  const path = join(directory, "config.json");
  try {
    await writeFile(
      path,
      JSON.stringify({
        schema: "mc.config/v1",
        authorizedGitHubLogins: ["owner"],
        projects: [
          { ...project, trackedMissionIssues: [42] },
          {
            ...project,
            projectId: "duplicate",
            constitution: { ...project.constitution, projectId: "duplicate" },
            trackedMissionIssues: [42],
          },
        ],
      }),
    );
    await assert.rejects(() => loadV2Configuration(path), /configured more than once/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("system failure is distinct from CTO-required presentation", () => {
  const card = missionCard({
    project,
    issueNumber: 42,
    githubUrl: "https://github.com/example/fixture/issues/42",
    mission: {
      mission: fixture.mission,
      sourceMissionDigest: "digest",
      latestRevision: 1,
      complete: false,
      ignoredHumanCommentIds: [],
      historyDigest: "history",
      recentTransitions: [],
    },
    lastActivity: new Date().toISOString(),
    systemFailure: {
      code: "CODEX_AUTHENTICATION_EXPIRED",
      message: "Codex authentication expired",
      actor: "ENGINEER",
      revision: 1,
      occurredAt: new Date().toISOString(),
    },
  });
  assert.equal(card.color, "GRAY");
  assert.equal(card.status, "Codex authentication expired");
});

test("provider failures are classified into bounded secret-free operator messages", () => {
  const cases = [
    ["authentication expired for bearer secret-value", "CODEX_AUTHENTICATION_EXPIRED"],
    ["usage limit reached", "CODEX_USAGE_LIMIT_REACHED"],
    ["thread resume not found", "PROVIDER_THREAD_UNAVAILABLE"],
    ["output schema mismatch with raw response", "PROVIDER_OUTPUT_INVALID"],
    ["provider child crashed with private detail", "PROVIDER_PROCESS_FAILED"],
    ["GitHub Issues request failed with token secret-value", "GITHUB_UNAVAILABLE"],
  ];
  for (const [raw, code] of cases) {
    const failure = classifyProviderFailure(new Error(raw), "ENGINEER", 4);
    assert.equal(failure.code, code);
    assert.doesNotMatch(failure.message, /secret-value|bearer|raw response|private detail/);
  }
});
