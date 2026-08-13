import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalHash } from "../lib/canonical-json";
import { AUTHENTICATED_RUNTIME_DEFERRED_STEP_IDS } from "../lib/acceptance-finalization-evidence";
import { createEvidenceHash, validateSemanticRequirement } from "../lib/acceptance-semantic-validation";
import { candidateIdentity, validationResultIdentity } from "../lib/acceptance-requirement-evidence";

const sha256File = async (path: string) =>
  createHash("sha256")
    .update(Uint8Array.from(await readFile(resolve(path))))
    .digest("hex");

async function main() {
  const [harnessArg, checkpointArg, outputArg] = process.argv.slice(2);
  if (!harnessArg || !checkpointArg || !outputArg)
    throw new Error("Usage: review-consensus-acceptance-evidence <harness.json> <checkpoint.json> <review.json>");
  const [harness, checkpoint, contract, checklist] = await Promise.all([
    readFile(resolve(harnessArg), "utf8").then(JSON.parse),
    readFile(resolve(checkpointArg), "utf8").then(JSON.parse),
    readFile(resolve("domain/consensus-real-provider-acceptance-contract.json"), "utf8").then(JSON.parse),
    readFile(resolve("docs/evidence/MISSION_AGENT_080_RUNTIME_V6_REVIEW_CHECKLIST.json"), "utf8").then(JSON.parse),
  ]);
  const startedAt = new Date().toISOString();
  if (
    checkpoint.checkpoint !== "before_independent_review" ||
    checkpoint.result !== "pass" ||
    checkpoint.acceptance_run_id !== harness.workspaceId
  )
    throw new Error("Independent review source checkpoint binding is invalid");
  if (
    checklist.contract_sha256 !== canonicalHash(contract) ||
    checklist.validator_registry_sha256 !== harness.candidateBindings.validatorRegistrySha256
  )
    throw new Error("Independent review checklist binding changed");
  const reviewSteps = contract.steps.filter((step: Record<string, unknown>) => step.lifecycle_phase === "pre_review");
  if (
    canonicalHash(checklist.steps) !==
    canonicalHash(
      reviewSteps.map((step: Record<string, unknown>) => ({
        step_id: step.step_id,
        requirement_id: step.requirement_id,
        lifecycle_phase: step.lifecycle_phase,
        implementation_identity: step.implementation_identity,
        validator_id: step.validator_id,
        validator_identity: step.validator_identity,
        required_evidence_fields: step.required_evidence_fields,
        pass_criteria_id: step.pass_criteria_id,
      })),
    )
  )
    throw new Error("Independent review scope is not the exact generated pre-review partition");
  const ledger = await Promise.all(
    reviewSteps.map(async (step: Record<string, unknown>) => {
      const row = harness.acceptanceRunPlan.find((item: Record<string, unknown>) => item.step_id === step.step_id);
      const artifact = harness.requirementArtifacts.find(
        (item: Record<string, unknown>) => item.artifactId === row?.evidenceArtifactId,
      );
      const bytes = artifact?.artifactPath ? await readFile(resolve(String(artifact.artifactPath))) : undefined;
      const artifactHash = bytes ? createHash("sha256").update(Uint8Array.from(bytes)).digest("hex") : null;
      const parsed = bytes ? JSON.parse(bytes.toString("utf8")) : undefined;
      const expectedApplicability = {
        provider: (step.applicable_providers as string[])?.[0] ?? null,
        model: (step.applicable_models as string[])?.[0] ?? null,
        role: (step.applicable_roles as string[])?.[0] ?? null,
        profile: (step.applicable_profiles as string[])?.[0] ?? null,
      };
      const actualApplicability = {
        provider: row?.provider ?? null,
        model: row?.model ?? null,
        role: row?.role ?? null,
        profile: row?.profile ?? null,
      };
      const artifactBindingsValid =
        parsed?.acceptanceRunId === harness.workspaceId &&
        parsed?.attemptId === harness.workspaceId &&
        parsed?.candidateIdentitySha256 === candidateIdentity(harness.candidateBindings) &&
        parsed?.stepId === step.step_id &&
        parsed?.requirementId === step.requirement_id &&
        parsed?.validatorId === step.validator_id &&
        canonicalHash({
          provider: parsed?.provider ?? null,
          model: parsed?.model ?? null,
          role: parsed?.role ?? null,
          profile: parsed?.profile ?? null,
        }) === canonicalHash(actualApplicability);
      const applicabilityValid =
        canonicalHash(actualApplicability) === canonicalHash(expectedApplicability) &&
        (!row?.assignmentId || parsed?.assignmentId === row.assignmentId);
      const semanticReasons = parsed
        ? validateSemanticRequirement({
            stepId: String(step.step_id),
            acceptanceRunId: String(harness.workspaceId),
            observation: {
              stepId: step.step_id,
              attemptId: harness.workspaceId,
              sourceEvidenceSha256: createEvidenceHash(parsed.proof),
            },
            details: parsed.proof,
            candidateBindings: harness.candidateBindings,
            ...actualApplicability,
          })
        : ["EVIDENCE_ARTIFACT_MISSING"];
      const exactAuthorizedDeferral =
        row?.result === "deferred_to_authenticated_acceptance" &&
        AUTHENTICATED_RUNTIME_DEFERRED_STEP_IDS.has(String(step.step_id)) &&
        semanticReasons.length === 1 &&
        semanticReasons[0] === "DEFERRED_TO_AUTHENTICATED_ACCEPTANCE";
      const passed =
        (row?.result === "passed" || exactAuthorizedDeferral) &&
        row.validatorId === step.validator_id &&
        row.validationResultIdentity &&
        validationResultIdentity(row) === row.validationResultIdentity &&
        artifact?.sha256 === row.evidenceSha256 &&
        artifactHash === row.evidenceSha256 &&
        artifactBindingsValid &&
        applicabilityValid &&
        (semanticReasons.length === 0 || exactAuthorizedDeferral);
      return {
        requirementId: step.requirement_id,
        stepId: step.step_id,
        validatorId: step.validator_id,
        validationResultIdentity: row?.validationResultIdentity ?? null,
        evidenceArtifactId: row?.evidenceArtifactId ?? null,
        result: row?.result ?? "missing",
        reviewerDisposition: passed ? "accepted" : "finding",
        finding: passed
          ? null
          : `Applicable mandatory requirement lacks exact semantic evidence: ${semanticReasons.join(",")}`,
      };
    }),
  );
  const findings = ledger.filter((item: Record<string, unknown>) => item.reviewerDisposition === "finding");
  const report = {
    schemaVersion: "consensus-independent-review-evidence/2",
    acceptanceRunId: harness.workspaceId,
    candidateBindings: harness.candidateBindings,
    evidenceIndexSha256: harness.evidenceIndex.sha256,
    canonicalEventSetSha256: harness.canonicalEventSet.sha256,
    reviewChecklistSha256: await sha256File("docs/evidence/MISSION_AGENT_080_RUNTIME_V6_REVIEW_CHECKLIST.json"),
    checklistVersion: checklist.schema_version,
    reviewerImplementationIdentity: await sha256File("scripts/review-consensus-acceptance-evidence.ts"),
    sourceCheckpointIdentity: checkpoint.binding_hash,
    startedAt,
    completedAt: new Date().toISOString(),
    requirementLedgerComplete: ledger.length === reviewSteps.length,
    unresolvedHigh: findings.length ? 1 : 0,
    unresolvedMedium: 0,
    requirementLedger: ledger,
  };
  await writeFile(resolve(outputArg), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify(report));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
