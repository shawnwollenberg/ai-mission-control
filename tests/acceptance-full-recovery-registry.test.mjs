import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("full contract acceptance seals every governed recovery scenario through the shared executor", async () => {
  const source = await readFile(new URL("../scripts/run-consensus-real-acceptance.ts", import.meta.url), "utf8");
  const expected = [
    ["REQ-F726328FF0F3994B", "provider_restart"],
    ["REQ-8F07660DBDB2F890", "lease_loss"],
    ["REQ-BF2841A5FA3154F2", "delayed_output"],
    ["REQ-3F10A64C778C6510", "conflicting_receipt"],
  ];
  assert.match(source, /await executeGovernedScenario\(\{/);
  for (const [requirementId, scenarioId] of expected) {
    assert.match(source, new RegExp(`['\"]${requirementId}['\"][\\s\\S]{0,180}['\"]${scenarioId}['\"]`));
  }
  assert.doesNotMatch(source, /if \(stepId\.startsWith\("recovery\."\)\) return matrixProof/);
});
