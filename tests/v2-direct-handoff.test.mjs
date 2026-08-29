import assert from "node:assert/strict";
import test from "node:test";
import { promoteDirectCodexHandoff } from "../v2/handoff/direct-codex-handoff.ts";
import { MemoryBindingStore } from "../v2/runtime/bindings.ts";

const project = {
  projectId: "permixa",
  name: "Permixa",
  githubRepo: "owner/permixa",
  localCheckout: "/work/permixa",
  repositoryUrl: "https://github.com/owner/permixa",
  architectAdapter: "codex-sdk",
  engineerAdapter: "codex-sdk",
  active: true,
  constitution: {
    schema: "mc.project-constitution/v1",
    projectId: "permixa",
    repository: "owner/permixa",
    defaultBranch: "main",
    architect: { adapter: "codex-sdk", channel: "CHATGPT" },
    engineer: { adapter: "codex-sdk" },
    authority: {
      engineer: ["CODE_WRITE"],
      architect: ["MISSION_APPROVE"],
      ctoRequired: ["OWNER_AUTHENTICATION"],
    },
  },
};
const configuration = { schema: "mc.config/v1", authorizedGitHubLogins: ["owner"], projects: [project] };

class MemoryIssueApi {
  issue;
  comments = [];
  labels = new Set();
  async ensureLabel(name) {
    this.labels.add(name);
  }
  async listTrackedIssueNumbers() {
    return this.issue ? [this.issue.number] : [];
  }
  async createIssue(input) {
    this.issue = {
      number: 7,
      url: "https://github.com/owner/permixa/issues/7",
      title: input.title,
      body: input.body,
      state: "open",
      stateReason: null,
      labels: input.labels,
      authorLogin: "owner",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      comments: this.comments,
    };
    return { number: 7, url: this.issue.url };
  }
  async readIssue() {
    return structuredClone(this.issue);
  }
  async addComment(_number, body) {
    this.comments.push({
      id: this.comments.length + 1,
      body,
      authorLogin: "owner",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    this.issue.comments = this.comments;
  }
  async updateIssue(_number, input) {
    if (input.labels) this.issue.labels = input.labels;
    if (input.state) this.issue.state = input.state;
  }
}

const input = {
  projectId: "permixa",
  codexThreadId: "11111111-1111-4111-8111-111111111111",
  title: "Resolve owner MFA blocker",
  objective: "Continue after owner authentication",
  currentStatus: "OWNER_REQUIRED",
  summary: "Waiting for owner MFA",
  blockedOn: ["OWNER_MFA"],
};

test("explicit handoff creates canonical tracked Mission and binds the existing Engineer thread", async () => {
  const issueApi = new MemoryIssueApi();
  const bindings = new MemoryBindingStore();
  const result = await promoteDirectCodexHandoff(input, {
    configuration,
    issueApi,
    bindings,
    findThreadCheckout: async () => "/work/permixa",
    readOrigin: async () => "git@github.com:owner/permixa.git",
  });
  assert.equal(result.issueNumber, 7);
  assert.equal(result.mission.state, "ARCHITECT_REVIEW");
  assert.equal(result.report.capabilitiesRequested[0], "OWNER_AUTHENTICATION");
  assert.ok(issueApi.issue.labels.includes("mc:tracked"));
  assert.equal((await bindings.list())[0].codexThreadId, input.codexThreadId);
});

test("duplicate thread and checkout/repository mismatch fail before creating another Issue", async () => {
  const bindings = new MemoryBindingStore();
  await bindings.put({
    missionId: "existing",
    projectId: "permixa",
    issueNumber: 1,
    codexThreadId: input.codexThreadId,
    lastProcessedRevision: 1,
  });
  for (const [findThreadCheckout, readOrigin, expected] of [
    [async () => "/wrong", async () => "https://github.com/owner/permixa", /CHECKOUT_MISMATCH/],
    [async () => "/work/permixa", async () => "https://github.com/owner/wrong", /REPOSITORY_MISMATCH/],
    [async () => "/work/permixa", async () => "https://github.com/owner/permixa", /ALREADY_BOUND/],
  ]) {
    const issueApi = new MemoryIssueApi();
    await assert.rejects(
      () => promoteDirectCodexHandoff(input, { configuration, issueApi, bindings, findThreadCheckout, readOrigin }),
      expected,
    );
    assert.equal(issueApi.issue, undefined);
  }
});
