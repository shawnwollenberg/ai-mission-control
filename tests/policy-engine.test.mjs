import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePolicy, POLICY_VERSION } from "../policy/policy-engine.ts";
import { classifyCommand, commandPolicy } from "../policy/command-classifier.ts";
import { enforceExecutionBudget } from "../policy/execution-budget.ts";
import { evaluateRemoteApproval } from "../policy/remote-approval-policy.ts";

const base = {
  environment: "development",
  agent: { status: "active", trustLevel: "controlled", capabilities: ["repository.write"] },
  repository: {
    defaultBranch: "main",
    protectedBranches: ["main"],
    allowedBranchPrefixes: ["codex/"],
    allowedRemotes: ["origin"],
    pushAllowed: true,
    pullRequestAllowed: true,
  },
  reversible: false,
  affectsExternalSystem: true,
};
test("policy deterministically gates exact generated branch publication", () => {
  const input = {
    ...base,
    actionType: "repository.push_branch",
    parameters: { branch: "codex/mission/task/execution", remote: "origin", commit: "abc", force: false },
  };
  const first = evaluatePolicy(input),
    second = evaluatePolicy(structuredClone(input));
  assert.deepEqual(first, second);
  assert.equal(first.outcome, "require_approval");
  assert.equal(first.policyVersion, POLICY_VERSION);
});
test("Publish for Review is one approval while merge and deployment remain denied", () => {
  const input = {
    ...base,
    repository: { ...base.repository, allowedBranchPrefixes: ["mission/"] },
    actionType: "repository.publish_for_review",
    parameters: {
      branch: "mission/abc-change",
      sourceBranch: "mission/abc-change",
      remote: "origin",
      targetBranch: "main",
      commit: "abc",
      force: false,
    },
  };
  const decision = evaluatePolicy(input);
  assert.equal(decision.outcome, "require_approval");
  assert.equal(decision.approvalType, "publish_for_review");
  assert.equal(evaluatePolicy({ ...input, parameters: { ...input.parameters, force: true } }).outcome, "deny");
  assert.equal(evaluatePolicy({ ...input, parameters: { ...input.parameters, branch: "main" } }).outcome, "deny");
  assert.equal(evaluatePolicy({ ...input, actionType: "repository.merge_pull_request" }).outcome, "deny");
  assert.equal(evaluatePolicy({ ...input, actionType: "deployment.start" }).outcome, "deny");
});
test("command classification denies destructive, infrastructure, secret, and unknown execution", () => {
  assert.equal(commandPolicy(classifyCommand(["node", "--test", "health.test.mjs"])), "allow");
  for (const command of [
    ["rm", "-rf", "build"],
    ["terraform", "apply"],
    ["cat", ".env"],
    ["mystery-tool", "go"],
  ])
    assert.equal(commandPolicy(classifyCommand(command)), "deny");
  assert.equal(commandPolicy(classifyCommand(["npm", "install", "left-pad"])), "require_approval");
});
test("hard execution budgets stop independently of the model", () => {
  const budget = { maxDurationSeconds: 60, maxRetries: 2, maxCommands: 3, maxArtifactBytes: 100, maxLogBytes: 50 };
  enforceExecutionBudget(budget, { commands: 3, artifactBytes: 100 });
  assert.throws(
    () => enforceExecutionBudget(budget, { commands: 4 }),
    (error) => error?.code === "validation_failed",
  );
});
test("policy denies permanent boundaries and scoped restrictions", () => {
  assert.equal(
    evaluatePolicy({ ...base, actionType: "repository.merge_pull_request", parameters: {} }).outcome,
    "deny",
  );
  assert.equal(
    evaluatePolicy({
      ...base,
      actionType: "repository.push_branch",
      parameters: { branch: "codex/x", remote: "origin" },
      restrictions: { deniedActions: ["repository.push_branch"] },
    }).outcome,
    "deny",
  );
});
test("protected/default/force/unapproved publication is denied even when approval is expected", () => {
  for (const parameters of [
    { branch: "main", remote: "origin" },
    { branch: "codex/x", remote: "origin", force: true },
    { branch: "feature/x", remote: "origin" },
    { branch: "codex/x", remote: "upstream" },
  ])
    assert.equal(evaluatePolicy({ ...base, actionType: "repository.push_branch", parameters }).outcome, "deny");
});
test("disabled agent and invalid pull request target are denied", () => {
  assert.equal(
    evaluatePolicy({
      ...base,
      agent: { ...base.agent, status: "disabled" },
      actionType: "repository.push_branch",
      parameters: { branch: "codex/x", remote: "origin" },
    }).outcome,
    "deny",
  );
  assert.equal(
    evaluatePolicy({ ...base, actionType: "repository.create_pull_request", parameters: { targetBranch: "release" } })
      .outcome,
    "deny",
  );
});

test("repository modification requires approval while merge, deploy, infrastructure, secrets, and transactions remain denied", () => {
  assert.equal(evaluateRemoteApproval("repository.modify").outcome, "require_approval");
  for (const action of [
    "repository.merge",
    "deployment.start",
    "infrastructure.modify",
    "secret.access",
    "transaction.sign",
    "transaction.submit",
  ]) {
    assert.equal(evaluateRemoteApproval(action).outcome, "deny");
  }
});
