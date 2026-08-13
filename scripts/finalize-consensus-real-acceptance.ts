import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { canonicalHash, canonicalJson } from "../lib/canonical-json";
import {
  createImmutableEvidenceIndex,
  candidateIdentity,
  type AcceptanceCandidateBindings,
  type RequirementEvidenceInput,
} from "../lib/acceptance-requirement-evidence";
import { loadApprovedAcceptanceSource, revalidateFinalAcceptanceSource } from "../lib/acceptance-source-checkpoints";
import type { DisposableAcceptanceArtifact } from "../lib/runtime-trust";
import { validateCleanupEvidence, validateIndependentReviewEvidence } from "../lib/acceptance-finalization-evidence";
import { createEvidenceHash } from "../lib/acceptance-semantic-validation";
import { orchestrateAcceptanceFinalization } from "../lib/acceptance-finalization-orchestrator";
import { createFinalAcceptanceRecord, sealCanonicalAcceptanceArtifact } from "../lib/acceptance-terminal-ledger";
import {
  appendSealedRetainedArtifact,
  extendAcceptanceResourceInventorySnapshot,
  planAcceptanceFinalizationResources,
  type AcceptanceResourceType,
} from "../lib/acceptance-resource-inventory";
import {
  acceptanceExecutableRegistry,
  acceptanceExecutableRegistryIdentity,
  assertAcceptanceEvidenceAccounting,
  executeAcceptanceRunPlan,
  generateAcceptanceContract,
  type GeneratedAcceptanceContract,
} from "./consensus-real-acceptance-steps";

async function currentContract() {
  const modules = new Set([
    "scripts/consensus-real-acceptance-steps.ts",
    ...acceptanceExecutableRegistry.flatMap((step) => step.boundSourceModules),
  ]);
  const hashes = Object.fromEntries(
    await Promise.all(
      Array.from(modules).map(async (path) => [
        path,
        createHash("sha256")
          .update(Uint8Array.from(await readFile(resolve(path))))
          .digest("hex"),
      ]),
    ),
  );
  const checkedIn = JSON.parse(
    await readFile(resolve("domain/consensus-real-provider-acceptance-contract.json"), "utf8"),
  ) as GeneratedAcceptanceContract;
  const generated = generateAcceptanceContract(hashes);
  if (canonicalJson(generated) !== canonicalJson(checkedIn))
    throw new Error("Acceptance contract is stale at finalization");
  return checkedIn;
}

let finalizeFailureCleanup: ((primaryError: unknown) => Promise<void>) | undefined;
let finalizationCleanupAttempted = false;

async function main() {
  const [harnessArg, reviewArg, cleanupArg, outputArg] = process.argv.slice(2);
  if (!harnessArg || !reviewArg || !cleanupArg || !outputArg)
    throw new Error(
      "Usage: finalize-consensus-real-acceptance <harness.json> <review.json> <cleanup.json> <output.json>",
    );
  const readJson = async (path: string) => JSON.parse(await readFile(resolve(path), "utf8"));
  const harness = await readJson(harnessArg);
  let cleanupHarnessPath = resolve(harnessArg);
  finalizeFailureCleanup = async (primaryError) => {
    if (finalizationCleanupAttempted) return;
    finalizationCleanupAttempted = true;
    const emergencyCleanupPath = resolve(`${outputArg}.emergency-cleanup.json`);
    let cleanupOutcome: Record<string, unknown>;
    try {
      await promisify(execFile)(
        process.execPath,
        [
          "--import",
          "tsx",
          resolve("scripts/cleanup-consensus-acceptance.ts"),
          cleanupHarnessPath,
          emergencyCleanupPath,
        ],
        { cwd: process.cwd(), env: process.env },
      );
      cleanupOutcome = { status: "passed", evidencePath: emergencyCleanupPath };
    } catch (cleanupError) {
      cleanupOutcome = {
        status: "partial_failure",
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      };
    }
    await writeFile(
      resolve(`${outputArg}.terminal-lifecycle.json`),
      `${JSON.stringify(
        {
          schemaVersion: "acceptance-terminal-lifecycle/1",
          acceptanceRunId: harness.workspaceId,
          primaryOutcome: {
            status: "failed",
            message: primaryError instanceof Error ? primaryError.message : String(primaryError),
          },
          cleanupOutcome,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    ).catch(() => undefined);
  };
  const contract = await currentContract();
  for (const path of [reviewArg, cleanupArg, outputArg])
    if (
      await stat(resolve(path))
        .then(() => true)
        .catch(() => false)
    )
      throw new Error(`Pre-seeded finalization output is forbidden: ${path}`);
  const finalizerChecklist = await readJson("docs/evidence/MISSION_AGENT_080_RUNTIME_V6_FINALIZER_CHECKLIST.json");
  if (harness.status !== "workflow_passed_pending_finalization" || !Array.isArray(harness.acceptanceRunPlan))
    throw new Error("Harness did not reach immutable pending finalization");
  const acceptanceRunId = String(harness.workspaceId);
  const candidateBindings = harness.candidateBindings as AcceptanceCandidateBindings;
  const contractSha256 = canonicalHash(contract);
  if (!candidateBindings || candidateBindings.acceptanceContractSha256 !== contractSha256)
    throw new Error("Harness candidate/contract binding changed");
  if (candidateBindings.executableRegistrySha256 !== acceptanceExecutableRegistryIdentity(contract))
    throw new Error("Harness executable-registry binding changed");
  const finalizerChecklistSha256 = createHash("sha256")
    .update(
      Uint8Array.from(await readFile(resolve("docs/evidence/MISSION_AGENT_080_RUNTIME_V6_FINALIZER_CHECKLIST.json"))),
    )
    .digest("hex");
  if (
    candidateBindings.finalizerChecklistSha256 !== finalizerChecklistSha256 ||
    finalizerChecklist.contract_sha256 !== contractSha256
  )
    throw new Error("Harness finalizer-checklist binding changed");
  const finalizerStepIds = contract.steps
    .filter((step) => step.lifecycle_phase !== "pre_review")
    .map((step) => step.step_id);
  if (
    canonicalJson(finalizerChecklist.steps.map((step: Record<string, unknown>) => step.step_id)) !==
    canonicalJson(finalizerStepIds)
  )
    throw new Error("Finalizer checklist is not the exact post-review lifecycle partition");
  const harnessIndex = createImmutableEvidenceIndex(harness.acceptanceRunPlan);
  if (harness.evidenceIndex?.sha256 !== harnessIndex.sha256)
    throw new Error("Harness immutable evidence index changed");
  assertAcceptanceEvidenceAccounting(contract, harness.acceptanceRunPlan, {
    acceptanceRunId,
    contractSha256,
    candidateBindings,
    phase: "harness",
  });
  if (
    !Array.isArray(harness.requirementArtifacts) ||
    harness.requirementArtifacts.length !== harness.acceptanceRunPlan.length
  )
    throw new Error("Requirement proof artifact index is incomplete");
  const artifactIds = new Set<string>();
  for (const row of harness.acceptanceRunPlan as Array<Record<string, unknown>>) {
    const indexed = harness.requirementArtifacts.find(
      (item: Record<string, unknown>) => item.artifactId === row.evidenceArtifactId,
    );
    if (!indexed || artifactIds.has(String(indexed.artifactId)))
      throw new Error(`Requirement proof artifact is missing or reused: ${row.step_id}`);
    artifactIds.add(String(indexed.artifactId));
    const bytes = await readFile(resolve(String(indexed.artifactPath)));
    const sha256 = createHash("sha256").update(Uint8Array.from(bytes)).digest("hex");
    if (sha256 !== row.evidenceSha256 || sha256 !== indexed.sha256)
      throw new Error(`Requirement proof artifact hash changed: ${row.step_id}`);
    const artifact = JSON.parse(bytes.toString("utf8"));
    const contractStep = contract.steps.find((step) => step.step_id === row.step_id);
    if (
      artifact.acceptanceRunId !== acceptanceRunId ||
      artifact.stepId !== row.step_id ||
      artifact.requirementId !== row.requirement_id ||
      artifact.validatorId !== row.validatorId ||
      artifact.candidateIdentitySha256 !== row.candidateIdentitySha256 ||
      artifact.schemaVersion !== contractStep?.evidence_schema
    )
      throw new Error(`Requirement proof artifact binding changed: ${row.step_id}`);
  }

  const approvedPacket = harness.missionAgent?.packetVerification?.approvedPacket as DisposableAcceptanceArtifact;
  const approvedSource = loadApprovedAcceptanceSource(approvedPacket);
  const sourceBinding = {
    artifact_sha256: candidateBindings.artifactSha256,
    acceptance_contract_sha256: candidateBindings.acceptanceContractSha256,
    executable_registry_sha256: candidateBindings.executableRegistrySha256,
    source_manifest_sha256: candidateBindings.acceptanceSourceManifestSha256,
  };
  const invoke = promisify(execFile);
  const finalizerArtifactRoot = resolve(dirname(resolve(outputArg)), "finalizer-requirement-artifacts");
  const retentionPolicyIdentity = String(
    harness.runResourceInventory?.resources?.find(
      (resource: Record<string, unknown>) => resource.expectedTerminalState === "retained_with_approved_reason",
    )?.retentionPolicyIdentity ?? "",
  );
  const plannedAt = new Date().toISOString();
  const retainedResource = (resourceId: string, type: AcceptanceResourceType, path: string, creatingStep: string) => ({
    resourceId,
    type,
    identity: { path },
    creatingStep,
    createdAt: plannedAt,
    cleanupPolicy: "retain_evidence_only" as const,
    expectedTerminalState: "retained_with_approved_reason" as const,
    retentionPolicyIdentity,
  });
  const preCleanupResources = [
    retainedResource(
      "checkpoint-before-independent-review",
      "source_checkpoint_artifact",
      resolve(`${outputArg}.before_independent_review.json`),
      "finalization.checkpoint",
    ),
    retainedResource("independent-review-artifact", "review_artifact", resolve(reviewArg), "finalization.review"),
    retainedResource(
      "checkpoint-before-final-cleanup",
      "source_checkpoint_artifact",
      resolve(`${outputArg}.before_final_cleanup.json`),
      "finalization.checkpoint",
    ),
  ];
  const evidenceIndexPath = resolve(`${outputArg}.evidence-index.json`);
  const delayedResources = [
    retainedResource("cleanup-evidence-artifact", "cleanup_artifact", resolve(cleanupArg), "finalization.cleanup"),
    retainedResource(
      "checkpoint-after-final-cleanup",
      "source_checkpoint_artifact",
      resolve(`${outputArg}.after_final_cleanup.json`),
      "finalization.checkpoint",
    ),
    ...acceptanceExecutableRegistry
      .filter((candidate) => candidate.executionPhase === "post_run")
      .map((step) =>
        retainedResource(
          `finalizer-proof-${step.requirementId}`,
          "finalizer_proof_artifact",
          resolve(finalizerArtifactRoot, `${step.requirementId}.json`),
          step.stepId,
        ),
      ),
    retainedResource("finalizer-proof-root", "finalizer_proof_artifact", finalizerArtifactRoot, "finalization.proofs"),
    retainedResource("final-evidence-index", "final_evidence_index", evidenceIndexPath, "finalization.index"),
  ];
  const finalizationInventory = planAcceptanceFinalizationResources(
    extendAcceptanceResourceInventorySnapshot(harness.runResourceInventory, preCleanupResources),
    delayedResources,
  );
  const finalizationHarnessPath = resolve(`${outputArg}.finalization-inventory.json`);
  await writeFile(
    finalizationHarnessPath,
    `${JSON.stringify({ ...harness, runResourceInventory: finalizationInventory }, null, 2)}\n`,
    { mode: 0o600, flag: "wx" },
  );
  cleanupHarnessPath = finalizationHarnessPath;
  const finalization = await orchestrateAcceptanceFinalization({
    checkpoint: (phase) =>
      revalidateFinalAcceptanceSource({
        approved: approvedSource,
        checkpoint: phase,
        acceptanceRunId,
        candidateBinding: sourceBinding,
      }),
    persistCheckpoint: async (checkpoint) => {
      await writeFile(
        resolve(`${outputArg}.${checkpoint.checkpoint}.json`),
        `${JSON.stringify(checkpoint, null, 2)}\n`,
        { mode: 0o600, flag: "wx" },
      );
    },
    runIndependentReview: async () => {
      await invoke(
        process.execPath,
        [
          "--import",
          "tsx",
          resolve("scripts/review-consensus-acceptance-evidence.ts"),
          resolve(harnessArg),
          resolve(`${outputArg}.before_independent_review.json`),
          resolve(reviewArg),
        ],
        { cwd: process.cwd() },
      );
      return readJson(reviewArg);
    },
    validateIndependentReview: (review, checkpoint) =>
      validateIndependentReviewEvidence(review, {
        acceptanceRunId,
        candidateBindings,
        evidenceIndexSha256: harnessIndex.sha256,
        canonicalEventSetSha256: harness.canonicalEventSet?.sha256,
        sourceCheckpointIdentity: checkpoint.binding_hash,
        sourceCheckpointValidatedAt: checkpoint.validated_at,
        requirementRows: harness.acceptanceRunPlan,
      }),
    runCleanup: async () => {
      await invoke(
        process.execPath,
        [
          "--import",
          "tsx",
          resolve("scripts/cleanup-consensus-acceptance.ts"),
          finalizationHarnessPath,
          resolve(cleanupArg),
        ],
        { cwd: process.cwd(), env: process.env },
      );
      return readJson(cleanupArg);
    },
    validateCleanup: (cleanup, checkpoint) => {
      validateCleanupEvidence(cleanup, {
        acceptanceRunId,
        candidateBindings,
        evidenceIndexSha256: harnessIndex.sha256,
        resourceInventory: finalizationInventory,
        sourceCheckpointValidatedAt: checkpoint.validated_at,
      });
      finalizationCleanupAttempted = true;
    },
  });
  const { beforeReview, review, beforeCleanup, cleanup, afterCleanup } = finalization;

  const now = new Date().toISOString();
  await mkdir(finalizerArtifactRoot, { recursive: true, mode: 0o700 });
  const finalizerRequirementArtifacts: Array<Record<string, string>> = [];
  const evidenceByStep: Record<string, RequirementEvidenceInput> = {};
  for (const step of acceptanceExecutableRegistry.filter((candidate) => candidate.executionPhase === "post_run")) {
    const proof = step.category === "review" ? review : cleanup;
    const artifact = {
      schemaVersion: step.evidenceSchema,
      acceptanceRunId,
      attemptId: acceptanceRunId,
      candidateIdentitySha256: canonicalHash(candidateBindings),
      stepId: step.stepId,
      requirementId: step.requirementId,
      validatorId: step.validatorId,
      provider: step.applicableProviders[0] ?? null,
      model: step.applicableModels[0] ?? null,
      role: step.applicableRoles[0] ?? null,
      profile: step.applicableProfiles[0] ?? null,
      assignmentId: null,
      proof,
    };
    const artifactBytes = `${canonicalJson(artifact)}\n`;
    const artifactSha256 = createHash("sha256").update(artifactBytes).digest("hex");
    const artifactId = `${step.category}:${step.requirementId}:${artifactSha256}`;
    const artifactPath = resolve(finalizerArtifactRoot, `${step.requirementId}.json`);
    await writeFile(artifactPath, artifactBytes, { mode: 0o600, flag: "wx" });
    finalizerRequirementArtifacts.push({
      artifactId,
      artifactPath,
      sha256: artifactSha256,
      stepId: step.stepId,
      requirementId: step.requirementId,
    });
    evidenceByStep[step.stepId] = {
      schemaVersion: "acceptance-requirement-evidence/1" as const,
      acceptanceRunId,
      attemptId: acceptanceRunId,
      stepId: step.stepId,
      requirementId: step.requirementId,
      validatorId: step.validatorId,
      candidateBindings,
      provider: step.applicableProviders[0] ?? null,
      model: step.applicableModels[0] ?? null,
      role: step.applicableRoles[0] ?? null,
      profile: step.applicableProfiles[0] ?? null,
      lifecyclePhase: step.lifecyclePhase,
      assignmentId: null,
      startedAt: now,
      completedAt: now,
      evidenceArtifactId: artifactId,
      evidenceArtifactSha256: artifactSha256,
      fields: {
        passCriteriaId: step.passCriteriaId,
        observation: {
          stepId: step.stepId,
          attemptId: acceptanceRunId,
          sourceEvidenceSha256: createEvidenceHash(proof),
        },
        details: proof,
      },
    };
  }
  const postRows = await executeAcceptanceRunPlan(
    contract,
    { acceptanceRunId, contractSha256, candidateBindings, evidenceByStep },
    "post_run",
  );
  const rows = [...harness.acceptanceRunPlan, ...postRows];
  assertAcceptanceEvidenceAccounting(contract, rows, { acceptanceRunId, contractSha256, candidateBindings });
  const evidenceIndex = createImmutableEvidenceIndex(rows);
  const allRequirementArtifacts = [...harness.requirementArtifacts, ...finalizerRequirementArtifacts] as Array<
    Record<string, unknown>
  >;
  if (
    allRequirementArtifacts.length !== contract.steps.length ||
    new Set(allRequirementArtifacts.map((item) => item.artifactId)).size !== contract.steps.length
  )
    throw new Error("Complete requirement proof-artifact index is missing or duplicated");
  for (const row of rows as Array<Record<string, unknown>>) {
    const indexed = allRequirementArtifacts.find((item) => item.artifactId === row.evidenceArtifactId);
    if (!indexed) throw new Error(`Final requirement proof artifact is missing: ${row.step_id}`);
    const bytes = await readFile(resolve(String(indexed.artifactPath)));
    const sha256 = createHash("sha256").update(Uint8Array.from(bytes)).digest("hex");
    const artifact = JSON.parse(bytes.toString("utf8"));
    if (
      sha256 !== row.evidenceSha256 ||
      sha256 !== indexed.sha256 ||
      artifact.acceptanceRunId !== acceptanceRunId ||
      artifact.candidateIdentitySha256 !== candidateIdentity(candidateBindings) ||
      artifact.stepId !== row.step_id ||
      artifact.requirementId !== row.requirement_id ||
      artifact.validatorId !== row.validatorId
    )
      throw new Error(`Final requirement proof artifact binding changed: ${row.step_id}`);
  }
  await writeFile(evidenceIndexPath, `${canonicalJson(evidenceIndex)}\n`, { mode: 0o600, flag: "wx" });
  type ArtifactObservation = { sha256: string; size: number; createdAt: string; sealedAt: string };
  const observeArtifact = async (path: string): Promise<ArtifactObservation> => {
    const observed = await stat(path);
    if (observed.isFile()) {
      const bytes = await readFile(path);
      return {
        sha256: createHash("sha256").update(Uint8Array.from(bytes)).digest("hex"),
        size: observed.size,
        createdAt: observed.birthtime.toISOString(),
        sealedAt: new Date().toISOString(),
      };
    }
    if (!observed.isDirectory()) throw new Error(`Finalization artifact is not a file or directory: ${path}`);
    const children = await readdir(path);
    const childArtifacts: Array<ArtifactObservation & { name: string }> = await Promise.all(
      children.sort().map(async (name) => ({ name, ...(await observeArtifact(resolve(path, name))) })),
    );
    return {
      sha256: canonicalHash(childArtifacts),
      size: childArtifacts.reduce((sum, child) => sum + child.size, 0),
      createdAt: observed.birthtime.toISOString(),
      sealedAt: new Date().toISOString(),
    };
  };
  let finalInventory = cleanup.resourceInventory as Record<string, unknown>;
  const finalizationResourceVerification: Array<Record<string, unknown>> = [];
  for (const resource of delayedResources) {
    const artifact = await observeArtifact(String(resource.identity.path));
    finalInventory = appendSealedRetainedArtifact(finalInventory, resource, artifact);
    finalizationResourceVerification.push({ resourceId: resource.resourceId, ...artifact });
  }
  const finalizedAt = new Date().toISOString();
  const finalSourceClosure = [beforeReview, beforeCleanup, afterCleanup];
  const terminalInventoryPath = resolve(`${outputArg}.terminal-inventory.json`);
  const terminalInventoryLedger = {
    schemaVersion: "consensus-acceptance-terminal-inventory-ledger/1",
    acceptanceRunId,
    candidateBindings,
    acceptanceSourceManifestSha256: candidateBindings.acceptanceSourceManifestSha256,
    acceptanceContractSha256: candidateBindings.acceptanceContractSha256,
    executableRegistrySha256: candidateBindings.executableRegistrySha256,
    validatorRegistrySha256: candidateBindings.validatorRegistrySha256,
    disposableRegistrySha256: candidateBindings.disposableRegistrySha256,
    authoritativeResourceInventoryIdentity: finalInventory.sha256,
    cleanupJournalTerminalSha256: cleanup.cleanupJournalTerminalSha256,
    registeredResourceIds: (finalInventory.resources as Array<Record<string, unknown>>).map(
      (resource) => resource.resourceId,
    ),
    terminalResourceRecords: finalInventory.outcomes,
    cleanupOutcomes: cleanup.resourceInventory.outcomes,
    finalSourceClosure,
    finalSourceClosureIdentity: canonicalHash(finalSourceClosure),
    independentReviewIdentity: canonicalHash(review),
    independentReviewResult: review,
    finalEvidenceIndexIdentity: evidenceIndex.sha256,
    requirementArtifacts: allRequirementArtifacts,
    resourceInventory: finalInventory,
    finalizationResourceVerification,
    createdAt: plannedAt,
    sealedAt: finalizedAt,
  };
  const sealedTerminalInventory = await sealCanonicalAcceptanceArtifact(terminalInventoryPath, terminalInventoryLedger);
  const terminalInventorySha256 = sealedTerminalInventory.sha256;
  const unresolvedHigh = Number(review.unresolvedHigh);
  const unresolvedMedium = Number(review.unresolvedMedium);
  if (unresolvedHigh !== 0 || unresolvedMedium !== 0) throw new Error("Final review has unresolved lifecycle findings");
  const finalAcceptanceRecord = createFinalAcceptanceRecord({
    acceptanceRunId,
    candidateBindings,
    terminalInventoryLedgerPath: terminalInventoryPath,
    terminalInventoryLedgerSha256: terminalInventorySha256,
    cleanupJournalTerminalSha256: String(cleanup.cleanupJournalTerminalSha256),
    evidenceIndexSha256: evidenceIndex.sha256,
    independentReviewIdentity: canonicalHash(review),
    independentReviewResult: review,
    finalSourceClosureIdentity: canonicalHash(finalSourceClosure),
    unresolvedHighCount: unresolvedHigh,
    unresolvedMediumCount: unresolvedMedium,
    finalizedAt,
  });
  await sealCanonicalAcceptanceArtifact(resolve(outputArg), finalAcceptanceRecord);
  console.log(
    JSON.stringify({
      status: "passed",
      evidence: resolve(outputArg),
      contractSha256,
      acceptanceRunId,
      evidenceIndexSha256: evidenceIndex.sha256,
      terminalInventorySha256,
      terminalInventoryPath,
    }),
  );
}

main().catch(async (error) => {
  const primaryMessage = error instanceof Error ? error.message : String(error);
  if (finalizeFailureCleanup) await finalizeFailureCleanup(error);
  console.error(primaryMessage);
  process.exitCode = 1;
});
