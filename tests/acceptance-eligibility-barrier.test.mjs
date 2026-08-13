import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { establishFreshEligibility } from "../lib/acceptance-eligibility-barrier.ts";

const role = (name, agentId, model, modelRole = "planner") => ({
  role: name,
  agentId,
  provider: agentId === "codex" ? "codex" : "claude_code",
  model,
  missionRole: modelRole === "executor" ? "executor" : "planner",
  modelRole,
  operations: modelRole === "executor" ? ["implement_change"] : ["generate_structured_plan"],
  requiredCapabilities: ["repository.read"],
  repositoryPermission: modelRole === "executor" ? "isolated_worktree_write" : "read",
});

const eligible = (binding, identity = "a".repeat(64)) => ({
  eligible: true,
  reasons: [],
  health: "active",
  score: 100,
  providerId: binding.provider,
  capabilityAttestationId: "11111111-1111-4111-8111-111111111111",
  capabilityAttestationHash: identity,
  providerRuntimeProfile: {
    profileId: `${binding.provider}-${binding.modelRole}`,
    runtimeBindingHash: "b".repeat(64),
  },
});

test("fresh barrier deduplicates heartbeats but validates every logical role", async () => {
  const roles = [
    role("planner_a", "claude", "claude-fable-5"),
    role("synthesizer", "claude", "claude-fable-5", "synthesizer"),
    role("planner_b", "codex", "gpt-5.6-sol"),
    role("executor", "codex", "gpt-5.6-luna", "executor"),
  ];
  const heartbeats = [];
  const evaluated = [];
  const result = await establishFreshEligibility({
    workspaceId: "workspace",
    repositoryId: "repository",
    requiredRoles: roles,
    heartbeat: async (agentId) => heartbeats.push(agentId),
    evaluate: async (input) => {
      const binding = roles.find((item) => item.agentId === input.agentId && item.model === input.requiredModel);
      evaluated.push(`${input.agentId}:${input.requiredModel}:${input.requiredModelRole}`);
      return eligible(binding);
    },
    action: async (observations) => observations.map((item) => item.role),
  });
  assert.deepEqual(heartbeats, ["claude", "codex"]);
  assert.equal(evaluated.length, 4);
  assert.deepEqual(result, ["planner_a", "synthesizer", "planner_b", "executor"]);
});

test("one bounded pre-action refresh is allowed and action is never retried", async () => {
  const binding = role("planner_a", "claude", "claude-fable-5");
  let evaluations = 0;
  let heartbeats = 0;
  let actions = 0;
  await establishFreshEligibility({
    workspaceId: "workspace",
    repositoryId: "repository",
    requiredRoles: [binding],
    heartbeat: async () => void (heartbeats += 1),
    evaluate: async () => (++evaluations === 1 ? { ...eligible(binding), eligible: false } : eligible(binding)),
    action: async () => void (actions += 1),
  });
  assert.equal(heartbeats, 2);
  assert.equal(evaluations, 2);
  assert.equal(actions, 1);

  await assert.rejects(
    establishFreshEligibility({
      workspaceId: "workspace",
      repositoryId: "repository",
      requiredRoles: [binding],
      heartbeat: async () => {},
      evaluate: async () => eligible(binding),
      action: async () => {
        actions += 1;
        throw new Error("command admission expired after action began");
      },
    }),
    /command admission expired/,
  );
  assert.equal(actions, 2);
});

test("expired, revoked, changed, or role-incompatible presentations fail closed", async () => {
  const binding = role("executor", "codex", "gpt-5.6-luna", "executor");
  for (const reason of ["expired", "revoked", "changed_identity", "wrong_role"]) {
    let actions = 0;
    await assert.rejects(
      establishFreshEligibility({
        workspaceId: "workspace",
        repositoryId: "repository",
        requiredRoles: [binding],
        heartbeat: async () => {},
        evaluate: async () => ({ ...eligible(binding), eligible: false, reasons: [reason] }),
        action: async () => void (actions += 1),
      }),
      /could not establish/,
    );
    assert.equal(actions, 0);
  }
});

test("late work creation has independent barriers and final replay follows it", async () => {
  const source = await readFile(new URL("../scripts/run-consensus-real-acceptance.ts", import.meta.url), "utf8");
  const positive = source.indexOf("const positiveClaimMission = await withFreshEligibility");
  const cancelled = source.indexOf("const cancelledClaimMission = await withFreshEligibility");
  const finalReplay = source.indexOf("const finalReplayQuiescenceRows");
  assert.ok(positive > 0);
  assert.ok(cancelled > positive);
  assert.ok(finalReplay > cancelled);
  assert.match(source, /afterAllWorkProducingScenarios: true/);
  assert.match(source, /runAvailableAgents\(agents, false\)/);
});
