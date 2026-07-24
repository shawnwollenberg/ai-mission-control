export const projectBrainContractVersion = "1.0";

export type ProjectBrainOperation =
  | "detect_repository"
  | "validate_repository"
  | "get_summary"
  | "prepare_context"
  | "read_context"
  | "record_closure"
  | "propose_learning"
  | "evaluate_learning"
  | "get_curation"
  | "list_knowledge"
  | "get_health"
  | "diagnostics";

export type ProjectBrainEnvelope<T = unknown> = {
  contract_version: string;
  operation: string;
  status: "succeeded" | "failed";
  repository: {
    id: string;
    checkout_path: string;
    head_sha: string;
    ending_head_sha?: string;
  } | null;
  artifacts: Array<Record<string, unknown>>;
  warnings: string[];
  blockers: string[];
  required_actions: string[];
  human_approval_required: boolean;
  repository_files_changed: boolean;
  exit_classification: string;
  data: T;
};

export type ProjectBrainCapabilities = {
  core_version: string;
  current_consumer_contract_version: string;
  consumer_contract_versions: string[];
  supported_artifact_schema_versions: string[];
  adapter_compatibility: { compatible: boolean; skill_adapter_version: string | null };
  operations: Record<string, { classification: string; human_approval_gated: boolean }>;
};

export type ProjectBrainAuditEvent = {
  eventType: "project_brain.adapter_invoked";
  workspaceId: string;
  repositoryId: string;
  missionId?: string;
  executionId?: string;
  operation: ProjectBrainOperation;
  contractVersion: string;
  exitClassification: string;
  exitStatus: number | null;
  argumentKeys: string[];
  startingSha: string | null;
  endingSha: string | null;
  durationMs: number;
  artifactReferences: string[];
  artifactChecksums: string[];
  stdoutSha256: string;
  stderrSha256: string;
};

export type ProjectBrainResult<T = unknown> = {
  envelope: ProjectBrainEnvelope<T>;
  auditEvent: ProjectBrainAuditEvent;
};
