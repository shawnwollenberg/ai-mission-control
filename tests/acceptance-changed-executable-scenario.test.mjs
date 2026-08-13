import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

import { assertCurrentStandaloneAuthority } from "../lib/acceptance-standalone-authority.ts";
import { canonicalHash } from "../lib/canonical-json.ts";

const template = await import("node:fs/promises").then(({ readFile }) =>
  readFile(new URL("../scripts/mission-agent-080.template.mjs", import.meta.url), "utf8"),
);
const classifierSource = template
  .match(/function classifyExpectedGovernedRejection\([\s\S]*?\n}\nfunction callbackConfirmsTerminal/)?.[0]
  .replace(/\nfunction callbackConfirmsTerminal$/, "");
assert.ok(classifierSource);
const context = vm.createContext({ Error });
vm.runInContext(`${classifierSource}; globalThis.classify = classifyExpectedGovernedRejection`, context);
const classify = context.classify;

test("exact changed-executable rejection is an accepted adversarial scenario", () => {
  const result = classify(
    {
      code: "validation_failed",
      details: {
        reason_code: "ASSIGNMENT_EXECUTABLE_BINDING_CHANGED",
        acceptance_scenario_baseline_valid: true,
        acceptance_scenario_rejection_recorded: true,
      },
    },
    "authority.changed_executable_rejected",
    "ASSIGNMENT_EXECUTABLE_BINDING_CHANGED",
  );
  assert.equal(result.commandOutcome, "rejected");
  assert.equal(result.scenarioOutcome, "passed_expected_governed_rejection");
});

for (const [name, rejection] of [
  ["wrong reason code", { code: "validation_failed", details: { reason_code: "ATTEMPT_BINDING_MISMATCH" } }],
  ["unexpected error", { code: "internal_error" }],
  ["missing rejection", undefined],
])
  test(`${name} remains an acceptance scenario failure`, () => {
    assert.throws(
      () => classify(rejection, "authority.changed_executable_rejected", "ASSIGNMENT_EXECUTABLE_BINDING_CHANGED"),
      (error) => error.classification === "acceptance_scenario_failure",
    );
  });

test("mock acceptance requires exact source and standalone authority hashes", async () => {
  const root = await mkdtemp(join(tmpdir(), "mc-standalone-authority-"));
  const route = join(root, "route.js");
  const source = join(root, "route.ts");
  const receiptPath = join(root, "receipt.json");
  await writeFile(route, "built");
  await writeFile(source, "source");
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const receipt = {
    schemaVersion: "acceptance-standalone-authority-build/1",
    sourceHashes: { [source]: hash("source") },
    boundaryHashes: { [route]: hash("built") },
  };
  await writeFile(receiptPath, JSON.stringify({ ...receipt, identitySha256: canonicalHash(receipt) }));
  assert.doesNotThrow(() => assertCurrentStandaloneAuthority({ receiptPath, authoritySources: [source] }));
  await writeFile(source, "changed source");
  assert.throws(
    () => assertCurrentStandaloneAuthority({ receiptPath, authoritySources: [source] }),
    /stale standalone authority boundary/,
  );
  await writeFile(source, "source");
  await writeFile(route, "changed built bytes");
  assert.throws(
    () => assertCurrentStandaloneAuthority({ receiptPath, authoritySources: [source] }),
    /boundary bytes changed/,
  );
});
