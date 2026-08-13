import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("governed rejection observations run in both disposable acceptance modes", async () => {
  const source = await readFile("scripts/run-consensus-real-acceptance.ts", "utf8");
  assert.match(
    source,
    /const governedDisposableAcceptance = \["mock_provider_acceptance", "consensus_real_provider_acceptance"\]\.includes/,
  );
  const scenarioStart = source.indexOf('scenarioBinding("REQ-6BD097D5CF920BF4", "wrong_canonical_plan_hash")');
  const governedGate = source.lastIndexOf("if (governedDisposableAcceptance)", scenarioStart);
  const mockOnlyGate = source.lastIndexOf("if (mockProviderValidation)", scenarioStart);
  assert.ok(scenarioStart > 0 && governedGate > mockOnlyGate);
  assert.match(source.slice(governedGate, scenarioStart), /executeGovernedScenario/);
});

test("Mission Control restart recovery runs in both disposable acceptance modes", async () => {
  const source = await readFile("scripts/run-consensus-real-acceptance.ts", "utf8");
  const coordinator = await readFile("scripts/restart-consensus-acceptance-server.ts", "utf8");
  assert.match(source, /if \(governedDisposableAcceptance && !focusedProviderRetry\) \{[\s\S]*?missionControlRestart:/);
  assert.doesNotMatch(
    source,
    /if \(process\.env\.CONSENSUS_PROVIDER_RUNTIME_MODE === "mock_provider_acceptance" && !focusedProviderRetry\)/,
  );
  assert.match(coordinator, /\["mock_provider_acceptance", "consensus_real_provider_acceptance"\]\.includes/);
  assert.match(coordinator, /process\.env\.APP_ENV !== "disposable_acceptance"/);
});
