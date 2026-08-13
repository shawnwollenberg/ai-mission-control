import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { format } from "prettier";
import {
  acceptanceExecutableRegistry,
  acceptanceExecutableRegistryIdentity,
  acceptanceValidatorRegistryIdentity,
  generateAcceptanceContract,
  validateExecutableRegistry,
} from "./consensus-real-acceptance-steps.ts";
import { canonicalHash } from "../lib/canonical-json.ts";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
validateExecutableRegistry();
const modules = new Set([
  "scripts/consensus-real-acceptance-steps.ts",
  ...acceptanceExecutableRegistry.flatMap((step) => step.boundSourceModules),
]);
const hashes = {};
for (const modulePath of [...modules].sort()) hashes[modulePath] = sha256(await readFile(resolve(modulePath)));
const contract = generateAcceptanceContract(hashes);
const reviewSteps = contract.steps.filter((step) => step.lifecycle_phase === "pre_review");
const finalizerSteps = contract.steps.filter((step) =>
  ["review", "cleanup", "post_cleanup"].includes(step.lifecycle_phase),
);
const partition = [...reviewSteps, ...finalizerSteps];
if (
  partition.length !== contract.steps.length ||
  new Set(partition.map((step) => step.step_id)).size !== contract.steps.length
)
  throw new Error("Review/finalizer lifecycle scopes do not exactly partition the acceptance contract");
if (contract.steps.some((step) => !["pre_review", "review", "cleanup", "post_cleanup"].includes(step.lifecycle_phase)))
  throw new Error("Acceptance requirement lacks a lifecycle phase");
const forbiddenObservationFields = /(^|\.)(satisfied|passed|success|result|prevalidated|suiteSuccess)$/;
for (const step of contract.steps)
  if (step.required_evidence_fields.some((field) => forbiddenObservationFields.test(field)))
    throw new Error(`Production acceptance schema contains harness-authored satisfaction field: ${step.step_id}`);
const harnessSource = await readFile(resolve("scripts/run-consensus-real-acceptance.ts"), "utf8");
if (/observation\s*:\s*\{[^}]*\b(satisfied|passed|success)\s*:/s.test(harnessSource))
  throw new Error("Real acceptance harness authors a requirement satisfaction field");
const semanticSource = await readFile(resolve("lib/acceptance-semantic-validation.ts"), "utf8");
if (/requirementCases|assertionCount/.test(semanticSource))
  throw new Error("Acceptance semantic validation contains a generic requirement fallback");
const contractPath = resolve("domain/consensus-real-provider-acceptance-contract.json");
const contractOutput = await format(JSON.stringify(contract), { parser: "json" });

const checklist = [
  "<!-- GENERATED FROM consensus-acceptance-executable-registry/1; DO NOT EDIT STEP IDS -->",
  "# Runtime-v6 mandatory acceptance checklist",
  "",
  ...contract.steps.map(
    (step) =>
      `- [ ] \`${step.step_id}\` — ${step.requirement_id} — ${step.category} — \`${step.implementation_identity}\``,
  ),
  "",
].join("\n");
const reviewOutput = await format(
  JSON.stringify(
    {
      schema_version: "consensus-acceptance-independent-review-checklist/1",
      contract_sha256: canonicalHash(contract),
      executable_registry_sha256: acceptanceExecutableRegistryIdentity(contract),
      validator_registry_sha256: acceptanceValidatorRegistryIdentity(contract),
      scope: "pre_review",
      steps: reviewSteps.map(
        ({
          step_id,
          requirement_id,
          lifecycle_phase,
          implementation_identity,
          validator_id,
          validator_identity,
          required_evidence_fields,
          pass_criteria_id,
        }) => ({
          step_id,
          requirement_id,
          lifecycle_phase,
          implementation_identity,
          validator_id,
          validator_identity,
          required_evidence_fields,
          pass_criteria_id,
        }),
      ),
    },
    null,
    2,
  ),
  { parser: "json" },
);
const finalizerOutput = await format(
  JSON.stringify(
    {
      schema_version: "consensus-acceptance-finalizer-checklist/1",
      contract_sha256: canonicalHash(contract),
      executable_registry_sha256: acceptanceExecutableRegistryIdentity(contract),
      validator_registry_sha256: acceptanceValidatorRegistryIdentity(contract),
      scope: ["review", "cleanup", "post_cleanup"],
      steps: finalizerSteps.map(
        ({
          step_id,
          requirement_id,
          lifecycle_phase,
          implementation_identity,
          validator_id,
          validator_identity,
          required_evidence_fields,
          pass_criteria_id,
        }) => ({
          step_id,
          requirement_id,
          lifecycle_phase,
          implementation_identity,
          validator_id,
          validator_identity,
          required_evidence_fields,
          pass_criteria_id,
        }),
      ),
    },
    null,
    2,
  ),
  { parser: "json" },
);
const checklistOutput = await format(checklist, { parser: "markdown" });
const outputs = [
  [contractPath, contractOutput],
  [resolve("docs/evidence/MISSION_AGENT_080_RUNTIME_V6_GENERATED_CHECKLIST.md"), checklistOutput],
  [resolve("docs/evidence/MISSION_AGENT_080_RUNTIME_V6_REVIEW_CHECKLIST.json"), reviewOutput],
  [resolve("docs/evidence/MISSION_AGENT_080_RUNTIME_V6_FINALIZER_CHECKLIST.json"), finalizerOutput],
];
if (process.argv.includes("--check")) {
  for (const [path, expected] of outputs) {
    const actual = await readFile(path, "utf8").catch(() => "");
    if (actual !== expected) throw new Error(`Generated acceptance contract output is stale: ${path}`);
  }
} else {
  for (const [path, output] of outputs) await writeFile(path, output);
}
console.log(
  JSON.stringify({
    event: "consensus_acceptance_contract_generated",
    stepCount: contract.steps.length,
    contractCanonicalSha256: canonicalHash(contract),
    executableRegistrySha256: acceptanceExecutableRegistryIdentity(contract),
    validatorRegistrySha256: acceptanceValidatorRegistryIdentity(contract),
    lifecycleCounts: Object.fromEntries(
      ["pre_review", "review", "cleanup", "post_cleanup"].map((phase) => [
        phase,
        contract.steps.filter((step) => step.lifecycle_phase === phase).length,
      ]),
    ),
  }),
);
