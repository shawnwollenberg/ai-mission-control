import type { ProjectBrainCapabilities, ProjectBrainEnvelope } from "./types";

export type ProjectBrainStatus =
  | "not_initialized"
  | "detected"
  | "valid"
  | "invalid"
  | "upgrade_available"
  | "incompatible"
  | "diagnostics_unavailable";

export function projectStatus(input: {
  capabilities?: ProjectBrainCapabilities;
  detection?: ProjectBrainEnvelope<Record<string, unknown>>;
  validation?: ProjectBrainEnvelope<Record<string, unknown>>;
  unavailable?: boolean;
}): ProjectBrainStatus {
  if (input.unavailable) return "diagnostics_unavailable";
  if (!input.capabilities) return "incompatible";
  if (!input.capabilities.consumer_contract_versions.includes("1.0")) return "incompatible";
  if (input.capabilities.adapter_compatibility.compatible === false) return "upgrade_available";
  if (input.detection?.exit_classification === "not_initialized") return "not_initialized";
  if (!input.detection) return "detected";
  if (input.validation?.status === "failed") return "invalid";
  if (input.validation?.status === "succeeded") return "valid";
  return "detected";
}

export function contextEvidence(
  envelope: ProjectBrainEnvelope<Record<string, unknown>>,
  expected: { missionId: string; executionId: string; startingSha: string },
) {
  const pack = envelope.data.context_pack as Record<string, unknown> | undefined;
  const binding = pack?.consumer_binding as Record<string, unknown> | undefined;
  const artifact = envelope.artifacts[0];
  const mismatches = [
    binding?.mission_id !== expected.missionId ? "mission_id" : null,
    binding?.execution_id !== expected.executionId ? "execution_id" : null,
    binding?.starting_sha !== expected.startingSha ? "starting_sha" : null,
    typeof artifact?.sha256 !== "string" ? "artifact_checksum" : null,
  ].filter((value): value is string => Boolean(value));
  return {
    valid: mismatches.length === 0,
    mismatches,
    timelineItem: {
      kind: "project_brain_context",
      title: "Verified Project Brain context",
      path: artifact?.path,
      checksum: artifact?.sha256,
      schemaVersion: artifact?.schema_version,
      contractVersion: envelope.contract_version,
      missionId: binding?.mission_id,
      executionId: binding?.execution_id,
      startingSha: binding?.starting_sha,
    },
  };
}

export function approvalInbox(
  knowledge: ProjectBrainEnvelope<Record<string, unknown>>,
  curation: ProjectBrainEnvelope<Record<string, unknown>>,
) {
  const groups = knowledge.data.knowledge as Record<string, unknown> | undefined;
  const proposals = Array.isArray(groups?.proposed) ? groups.proposed : [];
  const reviews = Array.isArray(curation.data.reviews) ? curation.data.reviews : [];
  const evaluatorReports = Array.isArray(curation.data.evaluations) ? curation.data.evaluations : [];
  const evaluations = [...evaluatorReports, ...reviews];
  return {
    proposals,
    evaluations,
    readOnly: true as const,
    availableAction: "open_repository_workflow" as const,
    promotionAvailable: false as const,
  };
}
