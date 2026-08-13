import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const template = readFileSync(new URL("../scripts/mission-agent-080.template.mjs", import.meta.url), "utf8");
const harness = readFileSync(new URL("../scripts/run-consensus-real-acceptance.ts", import.meta.url), "utf8");
const body = template.match(/function acceptanceProviderRestartRequired\([^)]*\) \{([\s\S]*?)\n\}/)?.[1];
assert.ok(body, "authenticated provider-restart boundary must remain extractable");
const required = Function("appEnv", "runtimeMode", "enabled", "operation", "providerAttempt", body);

test("authenticated provider restart is restricted to the first disposable implementation generation", () => {
  assert.equal(
    required("disposable_acceptance", "consensus_real_provider_acceptance", "true", "implementation", 1),
    true,
  );
  assert.equal(required("production", "consensus_real_provider_acceptance", "true", "implementation", 1), false);
  assert.equal(required("disposable_acceptance", "mock_provider_acceptance", "true", "implementation", 1), false);
  assert.equal(
    required("disposable_acceptance", "consensus_real_provider_acceptance", "false", "implementation", 1),
    false,
  );
  assert.equal(required("disposable_acceptance", "consensus_real_provider_acceptance", "true", "planning", 1), false);
  assert.equal(
    required("disposable_acceptance", "consensus_real_provider_acceptance", "true", "implementation", 2),
    false,
  );
});

test("authenticated harness requires the real retry, reset, and stale-attempt evidence", () => {
  assert.match(harness, /MISSION_AGENT_ACCEPTANCE_PROVIDER_RESTART_ONCE = "true"/);
  assert.match(harness, /if \(!focusedProviderRetry\) \{[\s\S]*retryDiagnostics\.length !== 2/);
  assert.match(harness, /retryEvidence\?\.retryDecision !== "retry_authorized"/);
  assert.match(harness, /resetEvidence\?\.contaminationAbsent !== true/);
  assert.match(harness, /staleRejection\?\.reason_code !== "ATTEMPT_BINDING_MISMATCH"/);
});
