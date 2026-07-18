import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePolicy, POLICY_VERSION } from "../policy/policy-engine.ts";

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
