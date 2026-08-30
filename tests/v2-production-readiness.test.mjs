import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CodexSdkArchitectAdapter } from "../v2/adapters/codex-sdk-architect.ts";
import { GitHubIssueMissionStore } from "../v2/github/github-issue-store.ts";
import { renderEnvelope, renderMissionBody } from "../v2/github/protocol.ts";
import { MissionOrchestrator } from "../v2/orchestration/orchestrator.ts";
import { JsonBindingStore, MemoryBindingStore } from "../v2/runtime/bindings.ts";
import { loadV2Configuration } from "../v2/runtime/config.ts";
import { startAutoRefreshScheduler, V2_DASHBOARD_REFRESH_INTERVAL_MS } from "../v2/ui/auto-refresh-scheduler.ts";
import { loadDashboardData } from "../v2/ui/dashboard-data.ts";
import { AutoRefreshStatus } from "../v2/ui/dashboard-auto-refresh.tsx";
import { MissionCardRow } from "../v2/ui/mission-card-row.tsx";
import { missionCardPresentation } from "../v2/ui/mission-card-presentation.ts";
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

function contrastRatio(foreground, background) {
  const luminance = (hex) => {
    const channels = hex
      .slice(1)
      .match(/.{2}/g)
      .map((channel) => Number.parseInt(channel, 16) / 255)
      .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

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

test("dashboard refresh reconstructs GitHub and worker changes without invoking any mutation", async () => {
  const api = new MemoryIssueApi();
  const mutationCalls = [];
  api.addComment = async (...args) => {
    mutationCalls.push(["addComment", ...args]);
    assert.fail("dashboard reads must not append GitHub comments");
  };
  api.updateIssue = async (...args) => {
    mutationCalls.push(["updateIssue", ...args]);
    assert.fail("dashboard reads must not update GitHub Issues");
  };
  const configuration = {
    schema: "mc.config/v1",
    authorizedGitHubLogins: ["owner"],
    projects: [{ ...project, trackedMissionIssues: [42] }],
  };
  let worker = {
    workerId: "personal-worker",
    displayName: "Owner Mac",
    sessionId: "session-1",
    status: "ONLINE",
    architectAvailable: true,
    engineerAvailable: true,
    lastSeenAt: "2026-08-29T20:34:20.000Z",
  };
  const dependencies = {
    loadConfiguration: async () => configuration,
    createIssueReader: (repository) => {
      assert.equal(repository, project.githubRepo);
      return api;
    },
    loadWorkerPresence: async () => worker,
    loadDispatches: async () => [],
  };

  const initial = await loadDashboardData(dependencies);
  assert.equal(initial.worker.status, "ONLINE");
  assert.equal(initial.cards.length, 1);
  assert.equal(initial.cards[0].state, "ENGINEER_WORKING");
  assert.equal(initial.cards[0].actor, "ENGINEER");
  assert.equal(initial.cards.filter((card) => card.state === "CTO_DECISION").length, 0);

  worker = { ...worker, status: "OFFLINE", lastSeenAt: "2026-08-29T20:33:20.000Z" };
  const offline = await loadDashboardData(dependencies);
  assert.equal(offline.worker.status, "OFFLINE");
  assert.equal(offline.cards[0].workerOffline, true);
  assert.match(offline.cards[0].status, /Engineer queued/);

  const signals = [
    {
      kind: "engineer-report",
      value: {
        ...completedReport(fixture.mission),
        capabilitiesRequested: ["SIGN_WALLET_MESSAGE"],
      },
    },
    {
      kind: "architect-decision",
      value: {
        schema: "mc.architect-decision/v1",
        missionId: fixture.mission.missionId,
        revision: 3,
        decision: "CTO_REQUIRED",
        rationale: "Exact owner decision required.",
        nextMission: null,
      },
    },
    {
      kind: "cto-request",
      value: {
        schema: "mc.cto-request/v1",
        missionId: fixture.mission.missionId,
        revision: 4,
        capability: "SIGN_WALLET_MESSAGE",
        action: "Approve inert authentication fixture",
        financialEffect: "$0",
        externalEffect: "No external effect",
        reversible: true,
        architectRecommendation: "REJECT",
        evidence: [{ kind: "engineer-report", revision: 2 }],
        status: "PENDING",
      },
    },
  ];
  const refreshedAt = new Date().toISOString();
  api.issue.comments.push(
    ...signals.map(({ kind, value }, index) => ({
      id: 100 + index,
      body: renderEnvelope(kind, value),
      authorLogin: "owner",
      createdAt: refreshedAt,
      updatedAt: refreshedAt,
    })),
  );
  api.issue.updatedAt = refreshedAt;
  api.issue.labels = ["mc:mission", "mc:engineer-working"];

  const refreshed = await loadDashboardData(dependencies);
  const inbox = refreshed.cards.filter((card) => card.state === "CTO_DECISION");
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].actor, "CTO");
  assert.equal(inbox[0].status, "Approve inert authentication fixture");
  assert.equal(inbox[0].color, "RED");
  assert.deepEqual(api.issue.labels, ["mc:mission", "mc:engineer-working"], "stale labels remain untouched");
  assert.deepEqual(mutationCalls, []);
});

test("every V2 mission card state defines readable text and link colors on its light surface", () => {
  for (const color of ["BLUE", "ORANGE", "RED", "GRAY", "BLACK", "WHITE"]) {
    const presentation = missionCardPresentation(color);
    assert.ok(presentation.foreground, `${color} must not inherit the global dark-theme foreground`);
    assert.ok(presentation.link, `${color} links must not use dark color-scheme browser defaults`);
    assert.ok(contrastRatio(presentation.foreground, presentation.background) >= 4.5, `${color} text contrast`);
    assert.ok(contrastRatio(presentation.link, presentation.background) >= 4.5, `${color} link contrast`);
  }

  assert.deepEqual(missionCardPresentation("BLACK"), {
    indicator: "#171717",
    background: "#ffffff",
    foreground: "#171717",
    link: "#0645ad",
  });
});

test("completed BLACK/NONE MissionCardRow consumes the accessible palette", () => {
  const html = renderToStaticMarkup(
    React.createElement(MissionCardRow, {
      card: {
        projectId: "project-1",
        projectName: "Completed project",
        missionId: "mission-complete",
        issueNumber: 42,
        actor: "NONE",
        state: "COMPLETE",
        status: "Acceptance evidence passes.",
        color: "BLACK",
        githubUrl: "https://github.com/example/fixture/issues/42",
        repositoryUrl: "https://github.com/example/fixture",
        lastActivity: "2026-08-29T00:00:00.000Z",
        sortRank: 4,
        ageMs: 0,
      },
    }),
  );

  assert.match(html, /<article style="[^"]*border-left:8px solid #171717/);
  assert.match(html, /<article style="[^"]*background:#ffffff;color:#171717/);
  assert.match(html, /Completed project<\/strong> · NONE/);
  assert.equal(html.match(/style="color:#0645ad"/g)?.length, 2, "both V2 card links apply the accessible color");
  assert.match(html, /href="\/v2\/projects\/project-1\?issue=42"[^>]*>Open<\/a>/);
  assert.match(html, /href="https:\/\/github\.com\/example\/fixture\/issues\/42"[^>]*>GitHub<\/a>/);
});

test("V2 dashboard auto-refresh schedules only while visible, resumes immediately, and cleans up", () => {
  const listeners = new Set();
  const visibility = {
    visibilityState: "visible",
    addEventListener: (type, listener) => {
      assert.equal(type, "visibilitychange");
      listeners.add(listener);
    },
    removeEventListener: (type, listener) => {
      assert.equal(type, "visibilitychange");
      listeners.delete(listener);
    },
  };
  const intervals = new Map();
  let nextTimerId = 1;
  const cleared = [];
  const timers = {
    setInterval: (callback, intervalMs) => {
      assert.equal(intervalMs, V2_DASHBOARD_REFRESH_INTERVAL_MS);
      const timerId = nextTimerId++;
      intervals.set(timerId, callback);
      return timerId;
    },
    clearInterval: (timerId) => {
      cleared.push(timerId);
      intervals.delete(timerId);
    },
  };
  let refreshes = 0;

  const cleanup = startAutoRefreshScheduler({ visibility, timers, refresh: () => refreshes++ });
  assert.equal(intervals.size, 1);
  intervals.values().next().value();
  assert.equal(refreshes, 1);

  visibility.visibilityState = "hidden";
  for (const listener of listeners) listener();
  assert.equal(intervals.size, 0);
  assert.deepEqual(cleared, [1]);

  visibility.visibilityState = "visible";
  for (const listener of listeners) listener();
  assert.equal(refreshes, 2, "visibility resume performs one immediate refresh");
  assert.equal(intervals.size, 1);

  cleanup();
  assert.equal(intervals.size, 0);
  assert.deepEqual(cleared, [1, 2]);
  assert.equal(listeners.size, 0);

  visibility.visibilityState = "hidden";
  const hiddenCleanup = startAutoRefreshScheduler({ visibility, timers, refresh: () => refreshes++ });
  assert.equal(intervals.size, 0, "a page mounted in the background does not schedule refresh work");
  hiddenCleanup();
  assert.equal(listeners.size, 0);
});

test("V2 dashboard refresh integration renders a subtle accessible status and mounts the client refresher", async () => {
  const html = renderToStaticMarkup(
    React.createElement(AutoRefreshStatus, { lastRefreshedAt: new Date("2026-08-29T20:34:20.000Z") }),
  );
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /Auto-refreshes while this page is visible every 30 seconds/);
  assert.match(html, /refreshed/);

  const dashboardSource = await readFile(new URL("../app/v2/page.tsx", import.meta.url), "utf8");
  assert.match(dashboardSource, /<DashboardAutoRefresh \/>/);
  assert.match(dashboardSource, /loadDashboardData\(\)/);
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
