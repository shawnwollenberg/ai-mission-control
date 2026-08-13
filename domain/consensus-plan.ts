import { ValidationFailedError } from "@/lib/application-errors";
import { canonicalHash } from "@/lib/canonical-json";
import { stableUuid } from "@/lib/stable-id";

export const consensusStatuses = [
  "draft",
  "ready",
  "capturing_independent_proposals",
  "proposals_complete",
  "critique_round",
  "revision_round",
  "canonicalization",
  "awaiting_final_verdicts",
  "consensus_reached",
  "consensus_not_reached",
  "awaiting_human_approval",
  "approved",
  "rejected",
  "implementation_mission_created",
  "completed",
  "failed",
  "cancelled",
] as const;
export type ConsensusStatus = (typeof consensusStatuses)[number];

export const consensusParticipantRoles = [
  "planner_a",
  "planner_b",
  "synthesizer",
  "executor",
  "implementation_reviewer",
] as const;
export type ConsensusParticipantRole = (typeof consensusParticipantRoles)[number];

export const consensusOperations = [
  "prepare_context",
  "proposal",
  "critique",
  "revision",
  "canonicalize",
  "verdict",
] as const;
export type ConsensusOperation = (typeof consensusOperations)[number];

export const consensusArtifactKinds = [
  "project_brain_context_pack",
  "consensus_proposal",
  "consensus_critique",
  "consensus_revision",
  "canonical_implementation_plan",
  "canonical_plan_verdict",
] as const;
export type ConsensusArtifactKind = (typeof consensusArtifactKinds)[number];

export const consensusTransitions: Record<ConsensusStatus, readonly ConsensusStatus[]> = {
  draft: ["ready", "failed", "cancelled"],
  ready: ["capturing_independent_proposals", "failed", "cancelled"],
  capturing_independent_proposals: ["proposals_complete", "consensus_not_reached", "failed", "cancelled"],
  proposals_complete: ["critique_round", "consensus_not_reached", "failed", "cancelled"],
  critique_round: ["revision_round", "consensus_not_reached", "failed", "cancelled"],
  revision_round: ["canonicalization", "consensus_not_reached", "failed", "cancelled"],
  canonicalization: ["awaiting_final_verdicts", "consensus_not_reached", "failed", "cancelled"],
  awaiting_final_verdicts: ["consensus_reached", "consensus_not_reached", "failed", "cancelled"],
  consensus_reached: ["awaiting_human_approval", "completed", "failed", "cancelled"],
  consensus_not_reached: ["cancelled"],
  awaiting_human_approval: ["approved", "rejected", "cancelled"],
  approved: ["implementation_mission_created", "rejected", "failed", "cancelled"],
  rejected: [],
  implementation_mission_created: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function assertConsensusTransition(current: ConsensusStatus, target: ConsensusStatus) {
  if (current === target) return;
  if (!consensusTransitions[current].includes(target))
    throw new ValidationFailedError(`Consensus transition ${current} -> ${target} is not allowed`);
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const checksum = /^[0-9a-f]{64}$/;
const objectionCategories = [
  "correctness",
  "security",
  "data",
  "operations",
  "testing",
  "scope",
  "assumption",
  "other",
];

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ValidationFailedError(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function requiredString(row: Record<string, unknown>, key: string, maximum = 40_000) {
  const value = row[key];
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /\u0000/.test(value))
    throw new ValidationFailedError(`${key} is required and must be bounded`);
  return value;
}
function requiredUuid(row: Record<string, unknown>, key: string) {
  const value = requiredString(row, key, 80);
  if (!uuid.test(value)) throw new ValidationFailedError(`${key} must be a UUID`);
  return value;
}
function requiredHash(row: Record<string, unknown>, key: string) {
  const value = requiredString(row, key, 64);
  if (!checksum.test(value)) throw new ValidationFailedError(`${key} must be a SHA-256 hash`);
  return value;
}
function list(row: Record<string, unknown>, key: string, maximum = 100) {
  const value = row[key];
  if (!Array.isArray(value) || value.length > maximum) throw new ValidationFailedError(`${key} must be a bounded list`);
  return value;
}
function stringList(row: Record<string, unknown>, key: string, maximum = 100) {
  const values = list(row, key, maximum);
  if (values.some((value) => typeof value !== "string" || !value.trim() || value.length > 10_000))
    throw new ValidationFailedError(`${key} must contain only bounded strings`);
  return values as string[];
}
function exactKeys(row: Record<string, unknown>, allowed: readonly string[]) {
  const extras = Object.keys(row).filter((key) => !allowed.includes(key));
  if (extras.length)
    throw new ValidationFailedError(`Consensus artifact contains unknown fields: ${extras.join(", ")}`);
}
function confidence(row: Record<string, unknown>) {
  if (
    typeof row.confidence !== "number" ||
    !Number.isFinite(row.confidence) ||
    row.confidence < 0 ||
    row.confidence > 1
  )
    throw new ValidationFailedError("confidence must be between zero and one");
}
function commonBinding(row: Record<string, unknown>, schema: string, includeAssignment = true) {
  if (row.schema_version !== schema) throw new ValidationFailedError(`Unsupported schema version; expected ${schema}`);
  requiredUuid(row, "mission_id");
  if (includeAssignment) requiredUuid(row, "assignment_id");
  requiredHash(row, "repository_snapshot");
  requiredHash(row, "context_pack_hash");
}

export type ParsedConsensusArtifact = {
  normalized: Record<string, unknown>;
  schemaVersion: string;
  verdict?: string;
  blockingObjections: { id: string; category: string; description: string; requiredChange: string }[];
  reviewedArtifactId?: string;
  revisesProposalArtifactId?: string;
  sourceArtifactIds?: string[];
  canonicalPlanHash?: string;
};

export type ConsensusObjectionIdentity = {
  missionId: string;
  consensusAttempt: number;
  sourceArtifactId: string;
  participantAssignmentId: string;
  round: number;
  rawProviderObjectionId: string;
};

/**
 * Mission Control owns objection identity. Provider-supplied IDs are retained as
 * provenance only and must never be used as database or resolution identities.
 */
export function canonicalConsensusObjectionId(input: ConsensusObjectionIdentity) {
  return stableUuid(
    JSON.stringify({
      schema: "mission-control-consensus-objection/1",
      missionId: input.missionId,
      consensusAttempt: input.consensusAttempt,
      sourceArtifactId: input.sourceArtifactId,
      participantAssignmentId: input.participantAssignmentId,
      round: input.round,
      rawProviderObjectionId: input.rawProviderObjectionId,
    }),
  );
}

export function parseConsensusArtifact(kind: ConsensusArtifactKind, body: Buffer): ParsedConsensusArtifact {
  if (body.byteLength > 512 * 1024) throw new ValidationFailedError("Consensus artifact exceeds the size limit");
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    throw new ValidationFailedError("Consensus artifact must be valid JSON");
  }
  const row = object(value, "Consensus artifact");
  let schemaVersion = "";
  let verdict: string | undefined;
  let reviewedArtifactId: string | undefined;
  let revisesProposalArtifactId: string | undefined;
  let sourceArtifactIds: string[] | undefined;
  let canonicalPlanHash: string | undefined;
  let blockers: { id: string; category: string; description: string; requiredChange: string }[] = [];

  if (kind === "consensus_proposal" || kind === "consensus_revision") {
    exactKeys(row, [
      "schema_version",
      "mission_id",
      "assignment_id",
      "repository_snapshot",
      "context_pack_hash",
      "problem_definition",
      "assumptions",
      "proposed_approach",
      "affected_components",
      "data_model_changes",
      "api_changes",
      "migration_plan",
      "implementation_steps",
      "validation_plan",
      "rollback_plan",
      "security_considerations",
      "operational_considerations",
      "risks",
      "open_questions",
      "recommended_executor_capabilities",
      "confidence",
      ...(kind === "consensus_revision"
        ? ["revises_proposal_artifact_id", "addresses_critique_artifact_id", "resolved_objection_ids"]
        : []),
    ]);
    schemaVersion = kind === "consensus_proposal" ? "consensus-plan-proposal/1" : "consensus-plan-revision/1";
    commonBinding(row, schemaVersion);
    for (const key of [
      "problem_definition",
      "proposed_approach",
      "assumptions",
      "affected_components",
      "data_model_changes",
      "api_changes",
      "migration_plan",
      "implementation_steps",
      "validation_plan",
      "rollback_plan",
      "security_considerations",
      "operational_considerations",
      "risks",
      "open_questions",
      "recommended_executor_capabilities",
    ]) {
      if (key === "problem_definition" || key === "proposed_approach") requiredString(row, key);
      else stringList(row, key);
    }
    if (kind === "consensus_revision") {
      revisesProposalArtifactId = requiredUuid(row, "revises_proposal_artifact_id");
      reviewedArtifactId = requiredUuid(row, "addresses_critique_artifact_id");
      stringList(row, "resolved_objection_ids");
    }
    confidence(row);
  } else if (kind === "consensus_critique") {
    exactKeys(row, [
      "schema_version",
      "mission_id",
      "assignment_id",
      "repository_snapshot",
      "context_pack_hash",
      "round",
      "reviewed_proposal_artifact_id",
      "agreements",
      "blocking_objections",
      "non_blocking_suggestions",
      "missing_validation",
      "missing_rollback_provisions",
      "unsupported_assumptions",
      "verdict",
      "confidence",
    ]);
    schemaVersion = "consensus-plan-critique/1";
    commonBinding(row, schemaVersion);
    if (row.round !== 1) throw new ValidationFailedError("Only critique round 1 is supported");
    reviewedArtifactId = requiredUuid(row, "reviewed_proposal_artifact_id");
    for (const key of [
      "agreements",
      "non_blocking_suggestions",
      "missing_validation",
      "missing_rollback_provisions",
      "unsupported_assumptions",
    ])
      stringList(row, key);
    list(row, "blocking_objections");
    blockers = (row.blocking_objections as unknown[]).map((entry) => {
      const item = object(entry, "Blocking objection");
      exactKeys(item, ["id", "category", "description", "required_change"]);
      const category = requiredString(item, "category", 32);
      if (!objectionCategories.includes(category)) throw new ValidationFailedError("Unsupported objection category");
      return {
        id: requiredString(item, "id", 120),
        category,
        description: requiredString(item, "description", 10_000),
        requiredChange: requiredString(item, "required_change", 10_000),
      };
    });
    if (new Set(blockers.map((blocker) => blocker.id)).size !== blockers.length)
      throw new ValidationFailedError("Blocking objection provider IDs must be unique within an artifact");
    verdict = requiredString(row, "verdict", 40);
    if (!["accept", "accept_with_changes", "reject"].includes(verdict))
      throw new ValidationFailedError("Unsupported critique verdict");
    confidence(row);
  } else if (kind === "canonical_implementation_plan") {
    exactKeys(row, [
      "schema_version",
      "mission_id",
      "repository_snapshot",
      "context_pack_hash",
      "objective",
      "accepted_assumptions",
      "rejected_assumptions",
      "architecture",
      "affected_components",
      "data_model_changes",
      "api_changes",
      "migration_plan",
      "ordered_implementation_steps",
      "acceptance_criteria",
      "validation_plan",
      "rollback_plan",
      "security_requirements",
      "operational_requirements",
      "known_risks",
      "deferred_items",
      "executor_requirements",
      "source_artifact_ids",
    ]);
    schemaVersion = "canonical-implementation-plan/1";
    commonBinding(row, schemaVersion, false);
    requiredString(row, "objective");
    requiredString(row, "architecture");
    for (const key of [
      "accepted_assumptions",
      "rejected_assumptions",
      "affected_components",
      "data_model_changes",
      "api_changes",
      "migration_plan",
      "ordered_implementation_steps",
      "acceptance_criteria",
      "validation_plan",
      "rollback_plan",
      "security_requirements",
      "operational_requirements",
      "known_risks",
      "deferred_items",
      "executor_requirements",
      "source_artifact_ids",
    ])
      stringList(row, key);
    if (!(row.validation_plan as unknown[]).length)
      throw new ValidationFailedError("Canonical implementation plan requires an owner-governed validation command");
    sourceArtifactIds = (row.source_artifact_ids as unknown[]).map((value) => {
      if (typeof value !== "string" || !uuid.test(value)) throw new ValidationFailedError("Invalid source artifact ID");
      return value;
    });
    canonicalPlanHash = canonicalHash(row);
  } else if (kind === "canonical_plan_verdict") {
    exactKeys(row, [
      "schema_version",
      "mission_id",
      "assignment_id",
      "canonical_plan_artifact_id",
      "canonical_plan_hash",
      "verdict",
      "blocking_objections",
      "non_blocking_notes",
      "confidence",
    ]);
    schemaVersion = "canonical-plan-verdict/1";
    if (row.schema_version !== schemaVersion) throw new ValidationFailedError("Unsupported verdict schema");
    requiredUuid(row, "mission_id");
    requiredUuid(row, "assignment_id");
    reviewedArtifactId = requiredUuid(row, "canonical_plan_artifact_id");
    canonicalPlanHash = requiredHash(row, "canonical_plan_hash");
    verdict = requiredString(row, "verdict", 80);
    if (!["approve", "approve_with_non_blocking_notes", "reject"].includes(verdict))
      throw new ValidationFailedError("Unsupported canonical plan verdict");
    const rawBlockers = stringList(row, "blocking_objections");
    blockers = rawBlockers.map((entry, index) => {
      return {
        id: `verdict-blocker-${index + 1}`,
        category: "other",
        description: entry,
        requiredChange: "New canonical plan required",
      };
    });
    stringList(row, "non_blocking_notes");
    confidence(row);
  } else {
    throw new ValidationFailedError("Project Brain context packs use the dedicated immutable context path");
  }

  return {
    normalized: row,
    schemaVersion,
    verdict,
    blockingObjections: blockers,
    reviewedArtifactId,
    revisesProposalArtifactId,
    sourceArtifactIds,
    canonicalPlanHash,
  };
}

export function consensusReached(verdicts: ParsedConsensusArtifact[]) {
  return (
    verdicts.length === 2 &&
    new Set(verdicts.map((item) => item.canonicalPlanHash)).size === 1 &&
    verdicts.every(
      (item) =>
        ["approve", "approve_with_non_blocking_notes"].includes(item.verdict ?? "") &&
        item.blockingObjections.length === 0,
    )
  );
}

export function assertConsensusArtifactSecretSafe(body: Buffer) {
  const text = body.toString("utf8");
  const patterns = [
    /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CREDENTIALS)-----/,
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/,
    /\bglpat-[A-Za-z0-9_-]{20,}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    /\bsk-(?:ant|proj)-[A-Za-z0-9_-]{20,}\b/,
    /\bmc_(?:agent|lease)_[A-Za-z0-9_-]{20,}\b/,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:/]+:[^\s@/]+@/i,
    /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}\b/i,
    /["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|password|private[_-]?key|secret|token)["']?\s*[:=]\s*["']?[^\s"',}\]]{12,}["']?/i,
  ];
  if (patterns.some((pattern) => pattern.test(text)))
    throw new ValidationFailedError("Consensus artifact contains secret-like material");
}

export function assertProjectBrainContextPack(body: Buffer, repositoryCommit: string) {
  if (!body.length || body.byteLength > 512 * 1024)
    throw new ValidationFailedError("Project Brain context pack is empty or oversized");
  const text = body.toString("utf8");
  const yamlSchema = /^schema_version:\s*2\.5\.0\s*$/m.test(text);
  const yamlType = /^artifact_type:\s*context-pack\s*$/m.test(text);
  const yamlSha = new RegExp(`^repository_sha:\\s*${repositoryCommit}\\s*$`, "m").test(text);
  let jsonValid = false;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    jsonValid =
      value.schema_version === "2.5.0" &&
      value.artifact_type === "context-pack" &&
      value.repository_sha === repositoryCommit;
  } catch {
    // Project Brain emits YAML by default; JSON is accepted for compatible adapters.
  }
  if (!(jsonValid || (yamlSchema && yamlType && yamlSha)))
    throw new ValidationFailedError("Project Brain context pack schema or repository binding does not match");
}
