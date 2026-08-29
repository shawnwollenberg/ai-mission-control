import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexSdkArchitectAdapter } from "../v2/adapters/codex-sdk-architect.ts";
import { CodexSdkEngineerAdapter } from "../v2/adapters/codex-sdk-engineer.ts";
import { OpenAIResponsesArchitectAdapter } from "../v2/adapters/openai-architect.ts";
import { GitHubIssueMissionStore } from "../v2/github/github-issue-store.ts";
import { renderMissionBody } from "../v2/github/protocol.ts";
import { MissionOrchestrator } from "../v2/orchestration/orchestrator.ts";
import { JsonBindingStore, MemoryBindingStore } from "../v2/runtime/bindings.ts";
import { missionCard, sortMissionCards } from "../v2/ui/view-model.ts";

const fixture = JSON.parse(await readFile(new URL("../fixtures/v2/agent-payment-risk-check.json", import.meta.url)));
const project = {
  projectId: fixture.constitution.projectId,
  name: "Agent Payment Risk Check",
  githubRepo: fixture.constitution.repository,
  localCheckout: "/tmp/fixture",
  repositoryUrl: `https://github.com/${fixture.constitution.repository}`,
  architectAdapter: "codex-sdk",
  engineerAdapter: "codex-sdk",
  active: true,
  constitution: fixture.constitution,
};

class MemoryIssueApi {
  next = 1;
  issue = {
    number: 42,
    url: "https://github.com/example/test/issues/42",
    title: "mission",
    body: renderMissionBody(fixture.mission),
    state: "open",
    stateReason: null,
    labels: ["mc:mission", "mc:engineer-working"],
    authorLogin: "mission-control-test",
    comments: [],
  };
  async readIssue() {
    return structuredClone(this.issue);
  }
  async addComment(_number, body) {
    this.issue.comments.push({
      id: this.next++,
      body,
      authorLogin: "mission-control-test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  async updateIssue(_number, input) {
    if (input.labels) this.issue.labels = [...input.labels];
    if (input.state) {
      this.issue.state = input.state;
      this.issue.stateReason = input.state === "closed" ? "completed" : "reopened";
    }
  }
}

const report = (mission, capabilitiesRequested = []) => ({
  schema: "mc.engineer-report/v1",
  missionId: mission.missionId,
  revision: mission.revision + 1,
  outcome: "COMPLETED",
  summary: `Engineer completed revision ${mission.revision + 1}`,
  evidence: [{ kind: "test", ref: "npm:test", result: "PASS" }],
  risks: [],
  blockedOn: [],
  capabilitiesRequested,
});

test("Codex adapter starts then resumes the same bounded thread", async () => {
  const calls = [];
  const thread = (id) => ({
    id,
    run: async (prompt, options) => {
      calls.push({ id, prompt, options });
      return {
        finalResponse: JSON.stringify(report(fixture.mission)),
        items: [],
        usage: null,
      };
    },
  });
  const client = { startThread: () => thread("thread-1"), resumeThread: (id) => thread(id) };
  const adapter = new CodexSdkEngineerAdapter(client);
  const first = await adapter.run({
    mission: fixture.mission,
    constitution: fixture.constitution,
    localCheckout: "/tmp/fixture",
  });
  await adapter.run({
    mission: fixture.mission,
    constitution: fixture.constitution,
    localCheckout: "/tmp/fixture",
    threadId: first.threadId,
  });
  assert.equal(first.threadId, "thread-1");
  assert.deepEqual(
    calls.map((call) => call.id),
    ["thread-1", "thread-1"],
  );
  assert.match(calls[0].prompt, /Never deploy, move money/);
  assert.equal(calls[0].options.outputSchema.additionalProperties, false);
  assert.deepEqual(calls[0].options.outputSchema.properties.evidence.items.required, ["kind", "ref", "result"]);
});

test("Codex may request an exact CTO escalation but cannot request ownerless authority", async () => {
  const make = (capability) => ({
    id: "thread-capability",
    run: async () => ({ finalResponse: JSON.stringify(report(fixture.mission, [capability])), items: [], usage: null }),
  });
  await new CodexSdkEngineerAdapter({
    startThread: () => make("SIGN_WALLET_MESSAGE"),
    resumeThread: () => make("SIGN_WALLET_MESSAGE"),
  }).run({ mission: fixture.mission, constitution: fixture.constitution, localCheckout: "/tmp/fixture" });
  await assert.rejects(
    () =>
      new CodexSdkEngineerAdapter({ startThread: () => make("REPO_PUSH"), resumeThread: () => make("REPO_PUSH") }).run({
        mission: fixture.mission,
        constitution: fixture.constitution,
        localCheckout: "/tmp/fixture",
      }),
    /no configured authority owner/,
  );
});

test("Codex Architect uses a separate read-only resumable thread and strict output", async () => {
  const calls = [];
  const decision = {
    schema: "mc.architect-decision/v1",
    missionId: fixture.mission.missionId,
    revision: 2,
    decision: "REMEDIATE",
    rationale: "One bounded validation step remains.",
    nextMission: {
      objective: "Run the bounded validation",
      acceptanceCriteria: ["Validation passes"],
      constraints: ["No deployment"],
    },
  };
  const thread = (id) => ({
    id,
    run: async (prompt, options) => {
      calls.push({ id, prompt, options });
      return { finalResponse: JSON.stringify(decision), items: [], usage: null };
    },
  });
  const client = { startThread: () => thread("architect-thread-1"), resumeThread: (id) => thread(id) };
  const adapter = new CodexSdkArchitectAdapter(client);
  const first = await adapter.review({
    mission: fixture.mission,
    constitution: fixture.constitution,
    localCheckout: "/tmp/fixture",
  });
  await adapter.review({
    mission: fixture.mission,
    constitution: fixture.constitution,
    localCheckout: "/tmp/fixture",
    architectThreadId: first.architectThreadId,
  });
  assert.equal(first.architectThreadId, "architect-thread-1");
  assert.deepEqual(
    calls.map((call) => call.id),
    ["architect-thread-1", "architect-thread-1"],
  );
  assert.match(calls[0].prompt, /read-only technical Architect/);
  assert.equal(calls[0].options.outputSchema.additionalProperties, false);
});

test("Responses Architect uses strict structured output, no tools, and resumes response context", async () => {
  const requests = [];
  const decision = {
    schema: "mc.architect-decision/v1",
    missionId: fixture.mission.missionId,
    revision: 2,
    decision: "APPROVE",
    rationale: "Evidence satisfies acceptance.",
    nextMission: null,
  };
  const adapter = new OpenAIResponsesArchitectAdapter(
    {
      responses: {
        create: async (input) => {
          requests.push(input);
          return { id: "resp-2", output_text: JSON.stringify(decision) };
        },
      },
    },
    "gpt-test",
  );
  const result = await adapter.review({
    mission: fixture.mission,
    constitution: fixture.constitution,
    previousResponseId: "resp-1",
  });
  assert.equal(result.responseId, "resp-2");
  assert.equal(requests[0].previous_response_id, "resp-1");
  assert.deepEqual(requests[0].tools, []);
  assert.equal(requests[0].text.format.strict, true);
});

test("closed loop remediates in one Codex thread, pauses for exact CTO authority, resumes, completes, and rebuilds", async () => {
  const api = new MemoryIssueApi();
  const store = new GitHubIssueMissionStore(api, {
    constitution: fixture.constitution,
    authorizedLogins: ["mission-control-test"],
  });
  const bindings = new MemoryBindingStore();
  const seenThreadIds = [];
  const engineerSignals = [];
  let engineerTurns = 0;
  const engineer = {
    run: async ({ mission, threadId, priorSignal }) => {
      seenThreadIds.push(threadId);
      engineerSignals.push(priorSignal);
      engineerTurns++;
      return {
        threadId: threadId ?? "codex-thread-42",
        report: report(mission, engineerTurns === 2 ? ["SIGN_WALLET_MESSAGE"] : []),
      };
    },
  };
  let architectTurns = 0;
  const architect = {
    review: async ({ mission, previousResponseId }) => {
      architectTurns++;
      const choices = [
        {
          decision: "REMEDIATE",
          rationale: "Add challenge-boundary coverage.",
          nextMission: {
            objective: "Add boundary coverage",
            acceptanceCriteria: ["Tests pass"],
            constraints: ["No wallet signature"],
          },
        },
        { decision: "CTO_REQUIRED", rationale: "Authorize a simulated signature boundary only.", nextMission: null },
        { decision: "APPROVE", rationale: "All acceptance evidence passes.", nextMission: null },
      ];
      assert.equal(previousResponseId, architectTurns === 1 ? undefined : `architect-${architectTurns - 1}`);
      return {
        responseId: `architect-${architectTurns}`,
        decision: {
          schema: "mc.architect-decision/v1",
          missionId: mission.missionId,
          revision: mission.revision + 1,
          ...choices[architectTurns - 1],
        },
      };
    },
  };
  const orchestrator = new MissionOrchestrator(project, store, bindings, engineer, architect);

  await orchestrator.advance(42); // Engineer report 2
  await orchestrator.advance(42); // Remediate 3
  await orchestrator.advance(42); // Same Engineer thread, report 4
  const waiting = await orchestrator.advance(42); // CTO decision 5 + exact request 6
  assert.equal(waiting.mission.state, "CTO_DECISION");
  assert.equal(waiting.pendingCtoRequest.capability, "SIGN_WALLET_MESSAGE");
  assert.deepEqual(seenThreadIds, [undefined, "codex-thread-42"]);
  assert.equal(engineerTurns, 2);
  await orchestrator.advance(42);
  assert.equal(engineerTurns, 2, "Engineer must not run while CTO request is pending");
  await assert.rejects(() => orchestrator.decide(42, { decision: "APPROVED", requestRevision: 5 }), /stale/);
  await orchestrator.decide(42, { decision: "APPROVED", requestRevision: 6, comment: "Simulated boundary only" });
  await orchestrator.advance(42); // Engineer report 8
  const complete = await orchestrator.advance(42); // Architect approve 9 and close
  assert.equal(complete.complete, true);
  assert.deepEqual(seenThreadIds, [undefined, "codex-thread-42", "codex-thread-42"]);
  assert.equal(engineerSignals[2].schema, "mc.cto-decision/v1");
  assert.equal(engineerSignals[2].requestRevision, 6);

  const rebuilt = await new GitHubIssueMissionStore(api, {
    constitution: fixture.constitution,
    authorizedLogins: ["mission-control-test"],
  }).reconcileMission({ issueNumber: 42 });
  assert.equal(rebuilt.historyDigest, complete.historyDigest);
  assert.equal(rebuilt.latestRevision, 9);
  const card = missionCard({
    project,
    issueNumber: 42,
    githubUrl: api.issue.url,
    mission: rebuilt,
    lastActivity: new Date().toISOString(),
  });
  assert.equal(card.color, "BLACK");
  assert.equal(card.actor, "NONE");
  assert.equal(sortMissionCards([card])[0].missionId, fixture.mission.missionId);
});

test("minimal provider bindings survive derived-cache reconstruction without mission history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mc-v2-bindings-"));
  const path = join(directory, "bindings.json");
  try {
    const first = new JsonBindingStore(path);
    await first.put({
      missionId: "mission-1",
      projectId: "project-1",
      issueNumber: 7,
      codexThreadId: "thread-7",
      architectResponseId: "response-7",
      lastProcessedRevision: 4,
    });
    const rebuilt = await new JsonBindingStore(path).get("mission-1");
    assert.deepEqual(rebuilt, {
      missionId: "mission-1",
      projectId: "project-1",
      issueNumber: 7,
      codexThreadId: "thread-7",
      architectResponseId: "response-7",
      lastProcessedRevision: 4,
    });
    assert.equal(JSON.stringify(rebuilt).includes("engineerReport"), false);
  } finally {
    await rm(directory, { recursive: true });
  }
});
