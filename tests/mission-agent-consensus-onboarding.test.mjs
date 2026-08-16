import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { onboardingProfile } from "../lib/mission-agent-onboarding.ts";

test("Standard onboarding remains pinned to legacy Mission Agent 0.7.2", () => {
  for (const agentType of ["codex", "claude_code", "hermes", "generic_remote"]) {
    const profile = onboardingProfile("standard", agentType);
    assert.equal(profile.missionAgentVersion, "0.7.2");
    assert.equal(profile.missionAgentChecksum, "108e5587e8ffce0c37639e041cd2dcc2b51079f395beb04b26c1d4d9330bee09");
    assert.equal(profile.providerProfile, undefined);
  }
});

test("Grok standard onboarding is Analyze-only on Mission Agent 0.7.3", () => {
  const grok = onboardingProfile("standard", "grok");
  assert.equal(grok.missionAgentVersion, "0.7.3");
  assert.equal(grok.missionAgentChecksum, "a4321cb88a98411941675e0a9343fc53710359f03ae4a79df0c1968accd555f4");
  assert.deepEqual(grok.capabilities, ["repository.read", "code.review", "artifact.create"]);
  assert.equal(onboardingProfile("consensus", "grok"), undefined);
});

test("Governed Consensus onboarding advertises only the frozen 0.8 provider/model roles", () => {
  const codex = onboardingProfile("consensus", "codex");
  assert.equal(codex.missionAgentVersion, "0.8.0");
  assert.equal(codex.missionAgentChecksum, "c366c95674fed2c8f63dd9f0182e54ee25d9a7d71764afe89b0facd734864494");
  assert.deepEqual(codex.providerProfile.supportedModels, ["gpt-5.6-luna", "gpt-5.6-sol"]);
  assert.deepEqual(
    codex.providerProfile.modelCapabilities.map(({ modelId, supportedRoles }) => ({ modelId, supportedRoles })),
    [
      { modelId: "gpt-5.6-sol", supportedRoles: ["planner", "synthesizer"] },
      { modelId: "gpt-5.6-luna", supportedRoles: ["executor"] },
    ],
  );
  assert.equal(codex.providerProfile.repositoryMutation, true);

  const claude = onboardingProfile("consensus", "claude_code");
  assert.deepEqual(claude.providerProfile.supportedModels, ["claude-fable-5"]);
  assert.deepEqual(claude.providerProfile.modelCapabilities[0].supportedRoles, ["planner", "synthesizer"]);
  assert.equal(claude.providerProfile.repositoryMutation, false);
  assert.equal(onboardingProfile("consensus", "hermes"), undefined);
  assert.equal(onboardingProfile("consensus", "generic_remote"), undefined);
  assert.equal(onboardingProfile("consensus", "grok"), undefined);
  assert.equal(onboardingProfile("unsupported", "codex"), undefined);
  assert.equal(onboardingProfile("standard", "unsupported"), undefined);
});

test("Consensus connection verifies signed sidecars, uses realpath, and does not replace the Standard service", async () => {
  const route = await readFile(new URL("../app/api/onboarding/connect/route.ts", import.meta.url), "utf8");
  assert.match(route, /mission-agent-consensus-\$\{body\.agentType\}/);
  assert.match(route, /mission-agent-\$\{missionAgentVersion\}\.mjs\.artifact\.json/);
  assert.match(route, /mission-agent-\$\{missionAgentVersion\}\.mjs\.capabilities\.json/);
  assert.match(route, /node "\$\(realpath "\$tmp"\)" connect/);
  assert.match(route, /--no-start/);
  assert.match(route, /cp "\$metadata" "\$agent_home\/mission-agent-\$\{missionAgentVersion\}\.mjs\.artifact\.json"/);
  assert.match(
    route,
    /cp "\$capabilities" "\$agent_home\/mission-agent-\$\{missionAgentVersion\}\.mjs\.capabilities\.json"/,
  );
  assert.match(route, /chmod 600 "\$agent_home\/mission-agent-\$\{missionAgentVersion\}\.mjs\.artifact\.json"/);
  assert.match(route, /nohup env MISSION_AGENT_HOME=/);
  assert.doesNotMatch(route, /mission-agent-latest\.json/);
});

test("UI distinguishes capability tracks and does not present 0.8 as a Standard upgrade", async () => {
  const wizard = await readFile(new URL("../app/onboarding/wizard.tsx", import.meta.url), "utf8");
  assert.match(wizard, />Standard</);
  assert.match(wizard, />Governed Consensus</);
  assert.match(wizard, /Not a Standard-agent upgrade/);
  assert.match(wizard, /accepts Consensus Plan work only/);
  assert.match(wizard, /mission_agent_version === "0\.8\.0"/);
});

test("legacy mission admission rejects Consensus-only 0.8 before creating canonical mission state", async () => {
  const source = await readFile(new URL("../application/onboarding-mission.ts", import.meta.url), "utf8");
  const rejection = source.indexOf('resource.mission_agent_version === "0.8.0"');
  const creation = source.indexOf("const missionId = randomUUID()");
  assert.ok(rejection > 0 && rejection < creation);
  assert.match(source, /Governed Consensus agents accept Consensus Plan assignments only/);
});

test("Mission Agent 0.8 keeps exact-model admission and no legacy selected-model fallback", async () => {
  const source = await readFile(new URL("../public/mission-agent-0.8.0.mjs", import.meta.url), "utf8");
  assert.match(source, /assignment\.consensus\?\.selectedModel \?\? assignment\.approvedPlan\?\.selectedModel/);
  assert.match(source, /if \(!model\) throw classifiedError\("Codex assignment has no exact approved model\./);
  assert.doesNotMatch(source, /selectedModel \?\? ["']standard["']/);
});
