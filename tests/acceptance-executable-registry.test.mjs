import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import contract from "../domain/consensus-real-provider-acceptance-contract.json";
import {
  acceptanceExecutableRegistry,
  acceptanceExecutableRegistryIdentity,
  acceptanceImplementationIdentity,
  assertAcceptanceEvidenceAccounting,
  createAcceptanceRunPlan,
  executeAcceptanceRunPlan,
  generateAcceptanceContract,
  validateExecutableRegistry,
} from "../scripts/consensus-real-acceptance-steps.ts";
import { canonicalHash } from "../lib/canonical-json.ts";
import { createImmutableEvidenceIndex } from "../lib/acceptance-requirement-evidence.ts";
import { createEvidenceHash } from "../lib/acceptance-semantic-validation.ts";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function sourceHashes() {
  const modules = new Set([
    "scripts/consensus-real-acceptance-steps.ts",
    ...acceptanceExecutableRegistry.flatMap((step) => step.boundSourceModules),
  ]);
  return Object.fromEntries(
    await Promise.all([...modules].map(async (module) => [module, sha256(await readFile(module))])),
  );
}
const candidateBindings = Object.freeze({
  artifactSha256: "1".repeat(64),
  artifactMetadataSha256: "2".repeat(64),
  capabilityManifestSha256: "3".repeat(64),
  acceptanceSourceManifestSha256: "4".repeat(64),
  acceptanceContractSha256: "5".repeat(64),
  executableRegistrySha256: "6".repeat(64),
  disposableRegistrySha256: "7".repeat(64),
  providerRequirementsSha256: "8".repeat(64),
  providerProfilesSha256: "9".repeat(64),
  runtimeBindingsSha256: "a".repeat(64),
  modelAssignmentsSha256: "b".repeat(64),
  repositorySnapshotSha256: "c".repeat(64),
  validatorRegistrySha256: "d".repeat(64),
  reviewChecklistSha256: "e".repeat(64),
  finalizerChecklistSha256: "1".repeat(64),
  reviewerImplementationSha256: "f".repeat(64),
  resourceInventoryImplementationSha256: "1".repeat(64),
  cleanupFinalizerSha256: "2".repeat(64),
  realAcceptanceHarnessSha256: "3".repeat(64),
});
const semanticDetails = (step) => {
  if (step.step_id.startsWith("source."))
    return {
      checkpoint: step.step_id.slice(7),
      result: "pass",
      missing_files: [],
      unexpected_files: [],
      changed_files: [],
      invalid_file_types: [],
    };
  if (step.step_id === "secrets.exact_credential_scan")
    return { secretScan: { durableMatches: 0, artifactFileMatches: 0, providerLogMatches: 0 } };
  if (step.step_id === "secrets.credential_pattern_scan") return { credentialPatternMatches: 0 };
  if (step.step_id === "secrets.lease_token_pattern_scan")
    return { rawLeaseTokenPatternMatches: { database: 0, localEvidenceFiles: 0 } };
  if (step.step_id === "secrets.forbidden_lease_token_key_scan")
    return { forbiddenLeaseTokenKeys: { database: 0, localEvidenceFiles: 0 } };
  if (step.step_id.startsWith("replay.")) return { deleted: true, rebuilt: true, equal: true };
  if (step.step_id.startsWith("models."))
    return {
      preflight: {
        implementationReviewer: "disabled",
        noFallback: true,
        assignments: [
          {
            role: step.applicable_roles[0],
            provider: step.applicable_providers[0],
            model: step.applicable_models[0],
            fallback: "disabled",
          },
        ],
      },
    };
  if (step.step_id.startsWith("runtime."))
    return {
      preflight: {
        assignments: [
          {
            provider: step.applicable_providers[0],
            runtimeProfileId: step.applicable_profiles[0],
            runtimeBindingHash: "a".repeat(64),
          },
        ],
      },
    };
  if (step.step_id.startsWith("workflow."))
    return {
      consensusMissionId: "00000000-0000-4000-8000-000000000011",
      childMissionId: "00000000-0000-4000-8000-000000000012",
      assertions: {
        preflight: { classification: "READY" },
        proposals: 2,
        critiques: 2,
        revisions: 2,
        canonicalPlanHash: "a".repeat(64),
        verdicts: [{ hash: "a".repeat(64) }, { hash: "a".repeat(64) }],
        singleHumanApproval: true,
        sameSnapshot: true,
        sameContext: true,
        childExecution: {
          status: "succeeded",
          commitId: "b".repeat(64),
          authorityInherited: true,
          executorExact: true,
        },
        learningCandidate: { status: "candidate" },
      },
    };
  if (step.step_id.startsWith("review."))
    return {
      schemaVersion: "consensus-independent-review-evidence/2",
      unresolvedHigh: 0,
      unresolvedMedium: 0,
      requirementLedgerComplete: true,
    };
  if (step.step_id.startsWith("cleanup.")) {
    const types = [
      ["provider_subprocess", "stopped"],
      ["mission_agent_process", "stopped"],
      ["process_group", "stopped"],
      ["mission_control_server", "stopped"],
      ["listener", "stopped"],
      ["disposable_database", "deleted"],
      ["database_process", "stopped"],
    ];
    const resources = types.map(([type, state], index) => ({
      resourceId: `resource-${index}`,
      type,
      expectedTerminalState: state,
    }));
    return {
      allRunResourcesAccounted: true,
      productionObservation: {
        runtimeMode: "disposable_acceptance",
        disposable: true,
        productionResourcesAllowed: false,
      },
      resourceInventory: {
        resources,
        outcomes: resources.map((resource) => ({
          resourceId: resource.resourceId,
          state: resource.expectedTerminalState,
        })),
      },
    };
  }
  throw new Error(`No narrow executable-registry fixture is defined for ${step.step_id}`);
};
const evidenceFor = (step, run, overrides = {}) => {
  const details = semanticDetails(step);
  return {
    schemaVersion: "acceptance-requirement-evidence/1",
    acceptanceRunId: run,
    attemptId: run,
    stepId: step.step_id,
    requirementId: step.requirement_id,
    validatorId: step.validator_id,
    candidateBindings,
    provider: step.applicable_providers[0] ?? null,
    model: step.applicable_models[0] ?? null,
    role: step.applicable_roles[0] ?? null,
    profile: step.applicable_profiles[0] ?? null,
    lifecyclePhase: step.lifecycle_phase,
    assignmentId: null,
    startedAt: "2026-08-05T00:00:00.000Z",
    completedAt: "2026-08-05T00:00:01.000Z",
    evidenceArtifactId: `requirement:${step.requirement_id}:${sha256(step.step_id)}`,
    evidenceArtifactSha256: sha256(step.step_id),
    fields: {
      passCriteriaId: step.pass_criteria_id,
      observation: { stepId: step.step_id, attemptId: run, sourceEvidenceSha256: createEvidenceHash(details) },
      details,
    },
    ...overrides,
  };
};

test("generated contract is the deterministic projection of live executable registrations", async () => {
  const generated = generateAcceptanceContract(await sourceHashes());
  assert.deepEqual(generated, contract);
  assert.equal(validateExecutableRegistry(), true);
  assert.equal(createAcceptanceRunPlan(generated).length, acceptanceExecutableRegistry.length);
  assert.equal(new Set(generated.steps.map((step) => step.step_id)).size, generated.steps.length);
  assert.equal(new Set(generated.steps.map((step) => step.requirement_id)).size, generated.steps.length);
  assert.match(acceptanceExecutableRegistryIdentity(generated), /^[a-f0-9]{64}$/);
});

test("removal, dead registration, optional demotion, duplicate IDs, and shared implementations fail", () => {
  const [first, second, ...rest] = acceptanceExecutableRegistry;
  assert.throws(() => createAcceptanceRunPlan({ ...contract, steps: contract.steps.slice(1) }), /absent/);
  assert.throws(() => validateExecutableRegistry([{ ...first, implementation: undefined }]), /Dead/);
  assert.throws(() => validateExecutableRegistry([{ ...first, mandatory: false }]), /demoted/);
  assert.throws(() => validateExecutableRegistry([first, { ...second, stepId: first.stepId }, ...rest]), /Duplicate/);
  assert.throws(
    () => validateExecutableRegistry([first, { ...second, implementation: first.implementation }, ...rest]),
    /reused/,
  );
});

test("implementation identity changes with source, configuration, and registry source bytes", async () => {
  const hashes = await sourceHashes();
  const step = acceptanceExecutableRegistry[0];
  const original = acceptanceImplementationIdentity(step, hashes);
  assert.notEqual(
    original,
    acceptanceImplementationIdentity(step, { ...hashes, [step.boundSourceModules[0]]: "f".repeat(64) }),
  );
  assert.notEqual(
    original,
    acceptanceImplementationIdentity({ ...step, evidenceSchema: `${step.evidenceSchema}-changed` }, hashes),
  );
  assert.notEqual(
    original,
    acceptanceImplementationIdentity(step, {
      ...hashes,
      "scripts/consensus-real-acceptance-steps.ts": "e".repeat(64),
    }),
  );
});

test("run plan executes every function and evidence accounts for every contract requirement", async () => {
  const generated = generateAcceptanceContract(await sourceHashes());
  const contractSha256 = canonicalHash(generated);
  const run = "00000000-0000-4000-8000-000000000001";
  const postRunSteps = generated.steps.filter((step) => step.execution_phase === "post_run");
  const evidenceByStep = Object.fromEntries(postRunSteps.map((step) => [step.step_id, evidenceFor(step, run)]));
  const rows = await executeAcceptanceRunPlan(
    generated,
    {
      acceptanceRunId: run,
      contractSha256,
      candidateBindings,
      evidenceByStep,
    },
    "post_run",
  );
  const accounting = { acceptanceRunId: run, contractSha256 };
  assert.equal(assertAcceptanceEvidenceAccounting(generated, rows, { ...accounting, phase: "post_run" }), true);
  assert.throws(
    () => assertAcceptanceEvidenceAccounting(generated, rows.slice(1), { ...accounting, phase: "post_run" }),
    /row count/,
  );
  assert.throws(
    () =>
      assertAcceptanceEvidenceAccounting(generated, [...rows.slice(1), { ...rows[0], step_id: "unknown.step" }], {
        ...accounting,
        phase: "post_run",
      }),
    /missing/,
  );
});

test("generated review and finalizer checklists exactly partition every canonical step", async () => {
  const runbook = await readFile("docs/evidence/MISSION_AGENT_080_RUNTIME_V6_GENERATED_CHECKLIST.md", "utf8");
  const review = JSON.parse(await readFile("docs/evidence/MISSION_AGENT_080_RUNTIME_V6_REVIEW_CHECKLIST.json", "utf8"));
  const finalizer = JSON.parse(
    await readFile("docs/evidence/MISSION_AGENT_080_RUNTIME_V6_FINALIZER_CHECKLIST.json", "utf8"),
  );
  assert.equal(review.contract_sha256, canonicalHash(contract));
  assert.deepEqual(
    review.steps.map((step) => step.step_id),
    contract.steps.filter((step) => step.lifecycle_phase === "pre_review").map((step) => step.step_id),
  );
  assert.deepEqual(
    finalizer.steps.map((step) => step.step_id),
    contract.steps.filter((step) => step.lifecycle_phase !== "pre_review").map((step) => step.step_id),
  );
  assert.equal(new Set([...review.steps, ...finalizer.steps].map((step) => step.step_id)).size, 123);
  for (const step of contract.steps) assert.equal(runbook.includes(`\`${step.step_id}\``), true);
});

test("evidence accounting rejects duplicate, cross-run, failed, and uncaused fail-stop rows", async () => {
  const generated = generateAcceptanceContract(await sourceHashes());
  const contractSha256 = canonicalHash(generated);
  const run = "00000000-0000-4000-8000-000000000002";
  const postRunSteps = generated.steps.filter((step) => step.execution_phase === "post_run");
  const evidenceByStep = Object.fromEntries(postRunSteps.map((step) => [step.step_id, evidenceFor(step, run)]));
  const rows = await executeAcceptanceRunPlan(
    generated,
    { acceptanceRunId: run, contractSha256, candidateBindings, evidenceByStep },
    "post_run",
  );
  const options = { acceptanceRunId: run, contractSha256, phase: "post_run" };
  assert.throws(
    () => assertAcceptanceEvidenceAccounting(generated, [rows[0], rows[0], ...rows.slice(2)], options),
    /duplicate/,
  );
  assert.throws(
    () =>
      assertAcceptanceEvidenceAccounting(
        generated,
        [{ ...rows[0], acceptance_run_id: "wrong" }, ...rows.slice(1)],
        options,
      ),
    /run binding/,
  );
  assert.throws(
    () =>
      assertAcceptanceEvidenceAccounting(
        generated,
        [{ ...rows[0], result: "failed", failureClassification: "TEST" }, ...rows.slice(1)],
        options,
      ),
    /did not pass/,
  );
  assert.throws(
    () =>
      assertAcceptanceEvidenceAccounting(
        generated,
        [{ ...rows[0], result: "not_reached_due_to_fail_stop" }, ...rows.slice(1)],
        { ...options, requireSuccess: false },
      ),
    /causal step/,
  );
});

test("run-plan failure stops subsequent execution and binds the causal step", async () => {
  const generated = generateAcceptanceContract(await sourceHashes());
  const contractSha256 = canonicalHash(generated);
  const postRunSteps = generated.steps.filter((step) => step.execution_phase === "post_run");
  const [first] = postRunSteps;
  const run = "00000000-0000-4000-8000-000000000003";
  const evidenceByStep = Object.fromEntries(
    postRunSteps.map((step) => [
      step.step_id,
      evidenceFor(
        step,
        run,
        step.step_id === first.step_id
          ? {
              fields: {
                passCriteriaId: step.pass_criteria_id,
                result: "failed",
                observation: { stepId: step.step_id, satisfied: false },
              },
            }
          : {},
      ),
    ]),
  );
  const rows = await executeAcceptanceRunPlan(
    generated,
    { acceptanceRunId: run, contractSha256, candidateBindings, evidenceByStep },
    "post_run",
  );
  assert.equal(rows[0].result, "failed");
  assert.equal(rows[1].result, "not_reached_due_to_fail_stop");
  assert.equal(rows[1].failStopStepId, first.step_id);
});

test("broad, partial, cross-run, cross-candidate, and wrong-validator evidence cannot receive requirement credit", async () => {
  const generated = generateAcceptanceContract(await sourceHashes());
  const contractSha256 = canonicalHash(generated);
  const run = "00000000-0000-4000-8000-000000000004";
  const postRunSteps = generated.steps.filter((step) => step.execution_phase === "post_run");
  const [first, second] = postRunSteps;
  const execute = async (firstEvidence) =>
    executeAcceptanceRunPlan(
      generated,
      {
        acceptanceRunId: run,
        contractSha256,
        candidateBindings,
        evidenceByStep: Object.fromEntries(
          postRunSteps.map((step) => [
            step.step_id,
            step.step_id === first.step_id ? firstEvidence : evidenceFor(step, run),
          ]),
        ),
      },
      "post_run",
    );
  for (const invalid of [
    evidenceFor(first, run, { stepId: second.step_id }),
    evidenceFor(first, "00000000-0000-4000-8000-000000000099"),
    evidenceFor(first, run, { candidateBindings: { ...candidateBindings, artifactSha256: "f".repeat(64) } }),
    evidenceFor(first, run, { validatorId: second.validator_id }),
    evidenceFor(first, run, { fields: { passCriteriaId: first.pass_criteria_id, result: "passed" } }),
    evidenceFor(first, run, {
      fields: {
        passCriteriaId: first.pass_criteria_id,
        result: "passed",
        observation: { stepId: second.step_id, satisfied: true },
      },
    }),
  ]) {
    const rows = await execute(invalid);
    assert.equal(rows[0].result, "failed");
    assert.equal(rows[1].result, "not_reached_due_to_fail_stop");
  }
});

test("immutable evidence index rejects duplicate and conflicting replacement credit", async () => {
  const generated = generateAcceptanceContract(await sourceHashes());
  const run = "00000000-0000-4000-8000-000000000005";
  const postRunSteps = generated.steps.filter((step) => step.execution_phase === "post_run");
  const rows = await executeAcceptanceRunPlan(
    generated,
    {
      acceptanceRunId: run,
      contractSha256: canonicalHash(generated),
      candidateBindings,
      evidenceByStep: Object.fromEntries(postRunSteps.map((step) => [step.step_id, evidenceFor(step, run)])),
    },
    "post_run",
  );
  assert.match(createImmutableEvidenceIndex(rows).sha256, /^[a-f0-9]{64}$/);
  assert.throws(() => createImmutableEvidenceIndex([rows[0], rows[0]]), /Duplicate/);
  assert.throws(
    () => createImmutableEvidenceIndex([rows[0], { ...rows[0], validationResultIdentity: "f".repeat(64) }]),
    /identity changed|Conflicting/,
  );
});

test("provider, model, role, and profile applicability are enforced by the designated validator", async () => {
  const generated = generateAcceptanceContract(await sourceHashes());
  const contractSha256 = canonicalHash(generated);
  const run = "00000000-0000-4000-8000-000000000006";
  const modelStep = generated.steps.find((step) => step.step_id === "models.executor_gpt_5_6_luna");
  const profileStep = generated.steps.find((step) => step.step_id === "runtime.codex_implementation_macos_v2");
  for (const [target, mutation] of [
    [modelStep, { provider: "claude_code" }],
    [modelStep, { model: "wrong-model" }],
    [modelStep, { role: "planner_a" }],
    [profileStep, { profile: "codex_planning_macos_v2" }],
  ]) {
    const executable = acceptanceExecutableRegistry.find((step) => step.stepId === target.step_id);
    const result = await executable.implementation({
      acceptanceRunId: run,
      contractSha256,
      candidateBindings,
      evidenceByStep: { [target.step_id]: evidenceFor(target, run, mutation) },
      validatorIdentityByStep: { [target.step_id]: target.validator_identity },
    });
    assert.equal(result.result, "failed");
  }
});

test("semantic validators reject harness success shortcuts, empty observations, placeholders, wrong values, and copied attempts", async () => {
  const generated = generateAcceptanceContract(await sourceHashes());
  const contractSha256 = canonicalHash(generated);
  const run = "00000000-0000-4000-8000-000000000007";
  const step = generated.steps.find((item) => item.step_id === "models.executor_gpt_5_6_luna");
  const valid = evidenceFor(step, run);
  const invalid = [
    { ...valid, fields: { ...valid.fields, observation: { ...valid.fields.observation, satisfied: true } } },
    { ...valid, fields: { ...valid.fields, observation: { ...valid.fields.observation, passed: true } } },
    { ...valid, fields: { ...valid.fields, observation: {} } },
    { ...valid, evidenceArtifactSha256: "0".repeat(64) },
    { ...valid, attemptId: "00000000-0000-4000-8000-000000000099" },
    { ...valid, provider: true },
    { ...valid, model: "gpt-placeholder" },
    { ...valid, role: "planner_b" },
    { ...valid, fields: { ...valid.fields, details: { suiteSuccess: true } } },
  ];
  for (const bad of invalid) {
    const executable = acceptanceExecutableRegistry.find((item) => item.stepId === step.step_id);
    const result = await executable.implementation({
      acceptanceRunId: run,
      contractSha256,
      candidateBindings,
      evidenceByStep: { [step.step_id]: bad },
      validatorIdentityByStep: { [step.step_id]: step.validator_identity },
    });
    assert.equal(result.result, "failed");
  }
});
