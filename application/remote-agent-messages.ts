import { getDatabasePool } from "@/lib/database";
import type { QueryResult, QueryResultRow } from "pg";
import { isAbsolute, relative, sep } from "node:path";
import { ValidationFailedError } from "@/lib/application-errors";
import { handleExecutionFact, handleExecutionTransition } from "@/application/execution-commands";
import { handleTaskTransition } from "@/application/task-commands";
import { appendEvents, loadAggregateEvents, loadAggregateHead } from "@/lib/postgres-event-store";
import { storeExecutionArtifact } from "@/execution/artifact-store";
import { stableUuid } from "@/lib/stable-id";
import { coordinateAfterTask } from "@/application/mission-coordinator";
import type { ProtocolEnvelope } from "@/remote-agent/protocol";
import { sha256 } from "@/remote-agent/protocol";
import { applyApprovalProjection, expireApproval, requestRemoteApproval } from "@/application/approval-commands";
import { recordUsage } from "@/application/usage-budget";
import { recordRepositoryRecommendations } from "@/application/recommendation-commands";
import { recordRepositoryHealthAssessment } from "@/application/repository-health-commands";
import type { RepositoryObservation } from "@/domain/repository-health";
import { applyProjectBrainProjection } from "@/application/project-brain-projector";
import { validateRemoteProjectBrainCapabilities } from "@/integrations/project-brain/remote-protocol";
import { processRemoteProjectBrainMessage } from "@/application/remote-project-brain-results";
import { verifyMissionAgentArtifact } from "@/integrations/mission-agent/artifact-manifest";
import { applyMissionAgentCapabilityProjection } from "@/application/mission-agent-capability-projector";
import { parseAgentProviderProfile } from "@/domain/agent-provider";
import {
  assertConsensusArtifactSecretSafe,
  consensusArtifactKinds,
  parseConsensusArtifact,
  type ConsensusArtifactKind,
} from "@/domain/consensus-plan";
import { recordConsensusArtifact } from "@/application/consensus-plan-commands";
import { canonicalHash } from "@/lib/canonical-json";
import { parseProviderRuntimeStatus, providerRuntimeStatusSatisfies } from "@/domain/provider-runtime-requirements";
import {
  maximumProviderRuntimeDiagnosticHistory,
  serverSanitizeProviderRuntimeDiagnostic,
} from "@/domain/provider-runtime-diagnostic";
import {
  assertDurableProtocolReceipt,
  durableProtocolReceipt,
  type LeaseAuthorizationKind,
  processingProtocolReceipt,
} from "@/domain/agent-protocol-receipt";
import {
  executionAuthorityPresentationIdentity,
  parseExecutionAuthorityPresentation,
} from "@/domain/execution-authority-presentation";

import { providerRuntimeProfileBinding } from "@/domain/provider-runtime-profiles";
import {
  persistActiveProviderAttempt,
  persistAuthorityLocalStateObservation,
} from "@/application/acceptance-authority-presentation-observations";

export function artifactPresentationVerificationMarker(
  binding: Record<string, unknown>,
  verificationMessageId: string,
) {
  return {
    schemaVersion: "artifact-presentation-verified/1",
    identity: canonicalHash(binding),
    binding,
    verificationMessageId,
  };
}
export function matchesArtifactPresentationVerificationMarker(
  value: unknown,
  binding: Record<string, unknown>,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  return (
    Object.keys(marker).sort().join(",") === "binding,identity,schemaVersion,verificationMessageId" &&
    marker.schemaVersion === "artifact-presentation-verified/1" &&
    typeof marker.verificationMessageId === "string" &&
    /^[0-9a-f-]{36}$/i.test(marker.verificationMessageId) &&
    marker.identity === canonicalHash(binding) &&
    canonicalHash(marker.binding) === canonicalHash(binding)
  );
}

export function latestArtifactPresentationMatches(markers: unknown[], binding: Record<string, unknown>) {
  return markers.length > 0 && matchesArtifactPresentationVerificationMarker(markers[0], binding);
}

type Credential = {
  workspace_id: string;
  agent_id: string;
  credential_id: string;
  credential_record_status: string;
};

type AuthorityQueryClient = {
  query<Row extends QueryResultRow = never>(text: string, values?: unknown[]): Promise<QueryResult<Row>>;
};

export async function validateExecutionAuthorityPresentation(
  message: ProtocolEnvelope,
  credential: Credential,
  database: AuthorityQueryClient = getDatabasePool(),
  activeRouteProviderAttemptId?: string,
) {
  const presented = parseExecutionAuthorityPresentation(message.payload.executionAuthorityPresentation);
  const authority = (
    await database.query<{
      assignment_id: string;
      attempt: number;
      agent_id: string;
      lease_owner: string;
      fencing_token: string;
      mission_id: string;
      parent_consensus_mission_id: string;
      repository_id: string;
      repository_snapshot_hash: string;
      repository_authority_hash: string;
      current_repository_authority_hash: string | null;
      context_pack_hash: string | null;
      canonical_plan_hash: string;
      provider_id: string;
      model_id: string;
      runtime_profile_id: string;
      runtime_profile_hash: string;
      capability_attestation_id: string;
      capability_attestation_hash: string;
      capability_expires_at: Date;
      capability_revoked_at: Date | null;
      current_capability_attestation_id: string | null;
      agent_status: string;
      provider_attempt_id: string;
      lease_receipt_id: string;
      lease_token_fingerprint: string;
      assignment_status: string;
      lease_expires_at: Date | null;
      lease_token_hash: string | null;
    }>(
      `SELECT p.assignment_id,p.attempt,p.agent_id,p.lease_owner,p.fencing_token::text,
         p.lease_receipt_id,p.lease_token_fingerprint,p.status assignment_status,
         p.lease_expires_at,p.lease_token_hash,
         p.mission_id,c.mission_id parent_consensus_mission_id,m.repository_id,
         p.payload#>>'{approvedPlan,repositorySnapshot}' repository_snapshot_hash,
         p.payload#>>'{approvedPlan,repositoryAuthorityHash}' repository_authority_hash,
         r.repository_authority_hash current_repository_authority_hash,
         p.payload#>>'{approvedPlan,contextPackHash}' context_pack_hash,
         p.payload#>>'{approvedPlan,hash}' canonical_plan_hash,
         a.provider_id,a.model_id,a.provider_runtime_requirements_id runtime_profile_id,
         a.provider_runtime_requirements_hash runtime_profile_hash,a.capability_attestation_id,
         a.capability_attestation_hash,cap.expires_at capability_expires_at,
         cap.revoked_at capability_revoked_at,ag.capability_attestation_id current_capability_attestation_id,
         ag.status agent_status,d.provider_attempt_id
       FROM pull_assignments p
       JOIN mission_projections m ON m.workspace_id=p.workspace_id AND m.mission_id=p.mission_id
       JOIN consensus_plan_projections c ON c.workspace_id=p.workspace_id AND c.mission_id=m.parent_consensus_mission_id
       JOIN consensus_participant_assignments a ON a.workspace_id=p.workspace_id AND a.mission_id=c.mission_id AND a.role='executor'
       JOIN agents ag ON ag.workspace_id=p.workspace_id AND ag.agent_id=p.agent_id
       JOIN repositories r ON r.workspace_id=p.workspace_id AND r.repository_id=m.repository_id
       JOIN agent_model_capability_attestations cap
         ON cap.workspace_id=p.workspace_id AND cap.capability_attestation_id=a.capability_attestation_id
       LEFT JOIN provider_runtime_diagnostics d ON d.workspace_id=p.workspace_id AND d.execution_id=p.execution_id
        AND d.execution_attempt=p.attempt AND d.agent_id=p.agent_id AND d.provenance_message_id=$5
       WHERE p.workspace_id=$1 AND p.execution_id=$2 AND p.assignment_id=$3 AND p.agent_id=$4
       ORDER BY d.created_at DESC LIMIT 1`,
      [credential.workspace_id, message.executionId, presented.assignmentId, credential.agent_id, message.messageId],
    )
  ).rows[0];
  if (!authority)
    throw new ValidationFailedError("Execution authority assignment binding is unavailable", {
      reason_code: "ASSIGNMENT_BINDING_MISMATCH",
    });
  if (!authority.lease_receipt_id || !authority.lease_token_fingerprint)
    throw new ValidationFailedError("Execution lease receipt binding is unavailable", {
      reason_code: "ASSIGNMENT_LEASE_STALE",
    });
  const runtime = providerRuntimeProfileBinding(authority.runtime_profile_id);
  const reject = (condition: boolean, reason_code: string, messageText: string) => {
    if (condition) throw new ValidationFailedError(messageText, { reason_code });
  };
  reject(
    presented.workspaceId !== credential.workspace_id ||
      presented.childMissionId !== authority.mission_id ||
      presented.parentMissionId !== authority.parent_consensus_mission_id ||
      presented.assignmentId !== authority.assignment_id ||
      presented.agentId !== authority.agent_id,
    "ASSIGNMENT_BINDING_MISMATCH",
    "Execution authority assignment binding does not match",
  );
  reject(
    presented.assignmentAttempt !== Number(authority.attempt),
    "ATTEMPT_BINDING_MISMATCH",
    "Execution authority attempt does not match",
  );
  reject(
    presented.providerAttemptId !== (activeRouteProviderAttemptId ?? authority.provider_attempt_id),
    "ATTEMPT_BINDING_MISMATCH",
    "Execution authority provider attempt does not match",
  );
  reject(
    presented.providerId !== authority.provider_id || presented.requestedModelId !== authority.model_id,
    "ASSIGNMENT_BINDING_MISMATCH",
    "Execution authority provider/model does not match",
  );
  reject(
    presented.executableIdentitySha256 !== runtime.invokedExecutableIdentitySha256 ||
      presented.executableSha256 !== runtime.invokedExecutableSha256,
    "ASSIGNMENT_EXECUTABLE_BINDING_CHANGED",
    "Execution authority executable binding does not match",
  );
  reject(
    presented.runtimeProfileId !== authority.runtime_profile_id ||
      presented.runtimeProfileHash !== authority.runtime_profile_hash ||
      presented.runtimeProfileHash !== runtime.runtimeBindingHash,
    "ASSIGNMENT_RUNTIME_PROFILE_CHANGED",
    "Execution authority runtime profile does not match",
  );
  reject(
    presented.authenticationBindingSha256 !== runtime.providerCredentialIdentitySha256,
    "ASSIGNMENT_AUTHENTICATION_BINDING_CHANGED",
    "Execution authority authentication binding does not match",
  );
  reject(
    presented.capabilityAttestationId !== authority.capability_attestation_id ||
      presented.capabilityAttestationHash !== authority.capability_attestation_hash ||
      authority.current_capability_attestation_id !== authority.capability_attestation_id ||
      authority.agent_status !== "active" ||
      authority.capability_revoked_at !== null ||
      Date.now() >= new Date(authority.capability_expires_at).getTime(),
    "CAPABILITY_ATTESTATION_EXPIRED",
    "Execution authority capability attestation is invalid",
  );
  reject(
    presented.repositoryId !== authority.repository_id ||
      presented.repositorySnapshotSha256 !== authority.repository_snapshot_hash ||
      presented.repositoryAuthoritySha256 !== authority.repository_authority_hash ||
      presented.repositoryAuthoritySha256 !== authority.current_repository_authority_hash,
    "ASSIGNMENT_REPOSITORY_AUTHORITY_CHANGED",
    "Execution authority repository binding does not match",
  );
  reject(
    presented.contextSha256 !== authority.context_pack_hash ||
      presented.canonicalPlanSha256 !== authority.canonical_plan_hash,
    "ASSIGNMENT_BINDING_MISMATCH",
    "Execution authority plan/context binding does not match",
  );
  reject(
    presented.leaseReceiptId !== authority.lease_receipt_id ||
      presented.leaseTokenFingerprint !== authority.lease_token_fingerprint ||
      presented.leaseOwner !== authority.lease_owner,
    "ASSIGNMENT_LEASE_STALE",
    "Execution authority lease binding is stale",
  );
  reject(
    presented.fencingToken !== Number(authority.fencing_token),
    "ASSIGNMENT_FENCING_TOKEN_STALE",
    "Execution authority fencing token is stale",
  );
  reject(
    !["leased", "acknowledged"].includes(authority.assignment_status) ||
      !authority.lease_expires_at ||
      new Date(authority.lease_expires_at).getTime() <= Date.now() ||
      !authority.lease_token_hash,
    "ASSIGNMENT_LEASE_STALE",
    "Execution authority lease is not active",
  );
  reject(
    presented.operationIdentitySha256 !==
      canonicalHash({
        operation: "implement_change",
        assignmentId: authority.assignment_id,
        executionId: message.executionId,
      }),
    "ASSIGNMENT_BINDING_MISMATCH",
    "Execution authority operation identity does not match",
  );
  reject(
    presented.resultAttemptIdentitySha256 !==
      canonicalHash({
        executionId: message.executionId,
        assignmentAttempt: Number(authority.attempt),
        providerAttemptId: activeRouteProviderAttemptId ?? authority.provider_attempt_id,
        completionMessageId: message.messageId,
      }),
    "ATTEMPT_BINDING_MISMATCH",
    "Execution authority result attempt does not match",
  );
  return { presentation: presented, presentationSha256: executionAuthorityPresentationIdentity(presented) };
}
async function executionRow(message: ProtocolEnvelope, workspaceId: string) {
  const row = (
    await getDatabasePool().query<{
      mission_id: string;
      task_id: string;
      agent_id: string;
      attempt: number;
      status: string;
      delivery_mode: string;
      repository_id: string | null;
      context_checksum: string | null;
      starting_sha: string | null;
      agent_verification_status: string | null;
      cancellation_requested_at: Date | null;
      output_fenced_at: Date | null;
      output_fence_reason: string | null;
      assignment_id: string | null;
    }>(
      `SELECT e.mission_id,e.task_id,e.agent_id,e.attempt,e.status,e.repository_id,e.cancellation_requested_at,
        a.delivery_mode,mp.context_checksum,mp.starting_sha,mp.agent_verification_status,
        pa.assignment_id,pa.output_fenced_at,pa.output_fence_reason FROM execution_projections e
       JOIN agents a ON a.workspace_id=e.workspace_id AND a.agent_id=e.agent_id
       LEFT JOIN pull_assignments pa ON pa.workspace_id=e.workspace_id AND pa.execution_id=e.execution_id
       LEFT JOIN mission_project_brain_projections mp ON mp.workspace_id=e.workspace_id AND mp.mission_id=e.mission_id
       WHERE e.workspace_id=$1 AND e.execution_id=$2`,
      [workspaceId, message.executionId],
    )
  ).rows[0];
  if (
    !row ||
    row.agent_id !== message.agentId ||
    row.mission_id !== message.missionId ||
    row.task_id !== message.taskId ||
    row.attempt !== message.attempt
  )
    throw new ValidationFailedError("Message is not authorized for this execution");
  return row;
}

async function validateFilesystemWriteAuthority(message: ProtocolEnvelope, credential: Credential, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ValidationFailedError("Provider filesystem-write authority is invalid", {
      reason_code: "FILESYSTEM_WRITE_EVIDENCE_INVALID",
    });
  const authority = value as Record<string, unknown>;
  const { authoritySha256, ...unsigned } = authority;
  const binding = (
    await getDatabasePool().query<{
      assignment_id: string;
      attempt: number;
      agent_id: string;
      mission_id: string;
      provider_id: string | null;
      model_id: string | null;
      runtime_profile_id: string | null;
      repository_id: string | null;
      repository_snapshot_hash: string | null;
      artifact_sha256: string | null;
    }>(
      `SELECT pa.assignment_id,pa.attempt,pa.agent_id,pa.mission_id,
         COALESCE(cpa.provider_id,a.provider_id) provider_id,
         COALESCE(cpa.model_id,pa.payload#>>'{approvedPlan,selectedModel}',pa.payload#>>'{consensus,selectedModel}') model_id,
         COALESCE(cpa.provider_runtime_requirements_id,
           pa.payload#>>'{approvedPlan,executorAssignment,providerRuntimeRequirementsId}',
           pa.payload#>>'{consensus,assignmentBinding,providerRuntimeRequirementsId}',
           a.provider_runtime_requirements_id) runtime_profile_id,
         COALESCE(pa.payload#>>'{approvedPlan,repositoryId}',pa.payload#>>'{consensus,repositoryId}',mp.repository_id::text) repository_id,
         COALESCE(pa.payload#>>'{approvedPlan,repositorySnapshot}',pa.payload#>>'{consensus,repositorySnapshot}') repository_snapshot_hash,
         a.mission_agent_artifact_checksum artifact_sha256
       FROM pull_assignments pa
       JOIN agents a ON a.workspace_id=pa.workspace_id AND a.agent_id=pa.agent_id
       LEFT JOIN mission_projections mp ON mp.workspace_id=pa.workspace_id AND mp.mission_id=pa.mission_id
       LEFT JOIN consensus_turns ct ON ct.workspace_id=pa.workspace_id AND ct.execution_id=pa.execution_id
       LEFT JOIN consensus_participant_assignments cpa
         ON cpa.workspace_id=ct.workspace_id AND cpa.participant_assignment_id=ct.participant_assignment_id
       WHERE pa.workspace_id=$1 AND pa.execution_id=$2 AND pa.assignment_id=$3 AND pa.agent_id=$4`,
      [credential.workspace_id, message.executionId, authority.assignmentId, credential.agent_id],
    )
  ).rows[0];
  const roots = authority.approvedWritableRoots;
  const readOnlyRoots = authority.readOnlyRoots;
  const validRoots = (candidate: unknown): candidate is string[] =>
    Array.isArray(candidate) &&
    candidate.length > 0 &&
    candidate.every((root) => typeof root === "string" && root.startsWith("/") && root !== "/") &&
    new Set(candidate).size === candidate.length;
  if (
    authority.schemaVersion !== "filesystem-write-authority/1" ||
    typeof authoritySha256 !== "string" ||
    canonicalHash(unsigned) !== authoritySha256 ||
    !binding ||
    authority.acceptanceRunId !== credential.workspace_id ||
    authority.workspaceId !== credential.workspace_id ||
    authority.missionId !== binding.mission_id ||
    authority.executionId !== message.executionId ||
    authority.assignmentId !== binding.assignment_id ||
    authority.assignmentAttempt !== Number(binding.attempt) ||
    authority.agentId !== binding.agent_id ||
    authority.provider !== binding.provider_id ||
    authority.model !== binding.model_id ||
    authority.runtimeProfileId !== binding.runtime_profile_id ||
    authority.repositoryId !== binding.repository_id ||
    authority.repositorySnapshotSha256 !== binding.repository_snapshot_hash ||
    authority.candidateArtifactSha256 !== binding.artifact_sha256 ||
    !/^\d+-\d+$/.test(String(authority.providerAttemptId ?? "")) ||
    !String(authority.providerAttemptId).startsWith(`${binding.attempt}-`) ||
    !validRoots(roots) ||
    !Array.isArray(readOnlyRoots) ||
    !readOnlyRoots.every((root) => typeof root === "string" && root.startsWith("/") && root !== "/")
  )
    throw new ValidationFailedError("Provider filesystem-write authority binding is invalid", {
      reason_code: "FILESYSTEM_WRITE_EVIDENCE_INVALID",
    });
  return authority;
}

export function assertFilesystemWriteObservationBinding(input: {
  observation: Record<string, unknown> & {
    evidenceSeal?: { algorithm?: string; subjectSha256?: string };
    allowedWrite?: Record<string, unknown>;
    deniedWrite?: Record<string, unknown>;
    descendantWrite?: Record<string, unknown>;
  };
  authority: Record<string, unknown> & {
    approvedWritableRoots?: unknown[];
  };
  registeredAuthoritySha256: string | null;
  workspaceId: string;
  missionId: string;
  executionId: string;
  assignmentId: string;
  assignmentAttempt: number;
}) {
  const { observation, authority } = input;
  const { observationIdentitySha256, evidenceSeal, ...unsignedObservation } = observation;
  const deniedCanonicalTarget = String(observation.deniedWrite?.canonicalTargetPath ?? "");
  const deniedTargetInsideApprovedRoot = Array.isArray(authority.approvedWritableRoots)
    ? authority.approvedWritableRoots.some((approvedRoot: unknown) => {
        if (typeof approvedRoot !== "string" || !isAbsolute(deniedCanonicalTarget)) return true;
        const suffix = relative(approvedRoot, deniedCanonicalTarget);
        return suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix));
      })
    : true;
  if (
    observation.schemaVersion !== "filesystem-write-observation/1" ||
    !/^[a-f0-9]{64}$/.test(String(observation.observationSchemaIdentitySha256 ?? "")) ||
    !/^[a-f0-9]{64}$/.test(String(observationIdentitySha256 ?? "")) ||
    canonicalHash(unsignedObservation) !== observationIdentitySha256 ||
    evidenceSeal?.algorithm !== "sha256" ||
    evidenceSeal.subjectSha256 !== observationIdentitySha256 ||
    observation.acceptanceRunId !== input.workspaceId ||
    observation.candidateArtifactSha256 !== authority.candidateArtifactSha256 ||
    observation.missionId !== input.missionId ||
    observation.executionId !== input.executionId ||
    observation.assignmentId !== input.assignmentId ||
    observation.assignmentAttempt !== input.assignmentAttempt ||
    observation.provider !== authority.provider ||
    observation.model !== authority.model ||
    observation.runtimeProfileId !== authority.runtimeProfileId ||
    observation.approvedWritableRoots === undefined ||
    canonicalHash(observation.approvedWritableRoots) !== canonicalHash(authority.approvedWritableRoots) ||
    observation.requestedTargetCanonicalPath !== observation.deniedWrite?.canonicalTargetPath ||
    deniedTargetInsideApprovedRoot ||
    observation.operation !== "create" ||
    observation.existsBefore !== false ||
    observation.errorClassification !== "provider_filesystem_write_forbidden" ||
    observation.reasonCode !== "FILESYSTEM_WRITE_FORBIDDEN" ||
    observation.existsAfter !== false ||
    observation.targetSha256 !== null ||
    !/^\d+-\d+$/.test(String(observation.providerAttemptId ?? "")) ||
    observation.providerAttemptId !== authority.providerAttemptId ||
    observation.allowedWrite?.allowed !== true ||
    observation.allowedWrite?.existsAfter !== true ||
    observation.deniedWrite?.allowed !== false ||
    observation.deniedWrite?.reasonCode !== "FILESYSTEM_WRITE_FORBIDDEN" ||
    observation.deniedWrite?.existedBefore !== observation.deniedWrite?.existsAfter ||
    observation.deniedWrite?.targetSha256Before !== observation.deniedWrite?.targetSha256After ||
    observation.descendantWrite?.attempted !== true ||
    observation.descendantWrite?.allowed !== false ||
    observation.descendantWrite?.targetExistsAfter !== false ||
    observation.descendantWrite?.reasonCode !== "FILESYSTEM_WRITE_FORBIDDEN" ||
    !/^[a-f0-9]{64}$/.test(String(observation.authoritySha256 ?? "")) ||
    authority.authoritySha256 !== observation.authoritySha256 ||
    input.registeredAuthoritySha256 !== observation.authoritySha256
  )
    throw new ValidationFailedError("Provider filesystem-write observation is invalid", {
      reason_code: "FILESYSTEM_WRITE_EVIDENCE_INVALID",
    });
}
const actor = (credential: Credential) => ({
  workspaceId: credential.workspace_id,
  id: credential.agent_id,
  type: "agent" as const,
});

async function persistProviderRuntimeDiagnostic(
  message: ProtocolEnvelope,
  credential: Credential,
  value: unknown = message.payload.providerDiagnostic,
) {
  if (value === undefined) return;
  const authority = (
    await getDatabasePool().query<{
      assignment_id: string;
      lease_owner: string | null;
      fencing_token: string;
      provider_id: string | null;
      provider_version: string | null;
      requested_model_id: string | null;
      runtime_profile_id: string | null;
      runtime_profile_hash: string | null;
      participant_assignment_id: string | null;
      role: string | null;
    }>(
      `SELECT pa.assignment_id,pa.lease_owner,pa.fencing_token,
         COALESCE(cpa.provider_id,a.provider_id) provider_id,
         a.provider_runtime_status->>'providerVersion' provider_version,
         COALESCE(cpa.model_id,pa.payload#>>'{approvedPlan,selectedModel}',pa.payload#>>'{consensus,selectedModel}') requested_model_id,
         COALESCE(cpa.provider_runtime_requirements_id,
           pa.payload#>>'{approvedPlan,executorAssignment,providerRuntimeRequirementsId}',
           pa.payload#>>'{consensus,assignmentBinding,providerRuntimeRequirementsId}',
           a.provider_runtime_requirements_id) runtime_profile_id,
         COALESCE(cpa.provider_runtime_requirements_hash,
           pa.payload#>>'{approvedPlan,executorAssignment,providerRuntimeRequirementsHash}',
           pa.payload#>>'{consensus,assignmentBinding,providerRuntimeRequirementsHash}',
           a.provider_runtime_requirements_hash) runtime_profile_hash,
         COALESCE(cpa.participant_assignment_id,
           (pa.payload#>>'{approvedPlan,executorAssignment,participantAssignmentId}')::uuid) participant_assignment_id,
         COALESCE(cpa.role,
           CASE WHEN pa.payload#>>'{approvedPlan,executorAssignment,participantAssignmentId}' IS NOT NULL
             THEN 'executor' END) role
       FROM pull_assignments pa
       JOIN agents a ON a.workspace_id=pa.workspace_id AND a.agent_id=pa.agent_id
       LEFT JOIN consensus_turns ct ON ct.workspace_id=pa.workspace_id AND ct.execution_id=pa.execution_id
       LEFT JOIN consensus_participant_assignments cpa
         ON cpa.workspace_id=ct.workspace_id AND cpa.participant_assignment_id=ct.participant_assignment_id
       WHERE pa.workspace_id=$1 AND pa.execution_id=$2 AND pa.agent_id=$3`,
      [credential.workspace_id, message.executionId, credential.agent_id],
    )
  ).rows[0];
  if (!authority || !authority.lease_owner)
    throw new ValidationFailedError("Provider diagnostic has no active assignment authority");
  const { diagnostic, serverSecretScan, diagnosticHash } = serverSanitizeProviderRuntimeDiagnostic(value);
  if (
    diagnostic.provider !== authority.provider_id ||
    diagnostic.requestedModel !== authority.requested_model_id ||
    diagnostic.cliVersion !== authority.provider_version ||
    diagnostic.runtimeProfileId !== authority.runtime_profile_id ||
    diagnostic.runtimeProfileHash !== authority.runtime_profile_hash
  )
    throw new ValidationFailedError("Provider diagnostic runtime binding does not match the assignment");
  const diagnosticId = stableUuid(
    `provider-runtime-diagnostic:${message.executionId}:${message.attempt}:${diagnostic.providerAttemptId}`,
  );
  const inserted = await getDatabasePool().query<{ diagnostic_id: string }>(
    `INSERT INTO provider_runtime_diagnostics(
       workspace_id,diagnostic_id,diagnostic_schema_version,mission_id,task_id,execution_id,execution_attempt,
       assignment_id,participant_assignment_id,role,agent_id,provider_id,requested_model_id,cli_version,
       runtime_profile_id,runtime_profile_hash,sandbox_profile_hash,provider_attempt_id,lease_owner,fencing_token,
       process_started_at,process_terminated_at,exit_code,termination_signal,timed_out,cancellation_requested,
       stdout_hash,stderr_hash,stdout_excerpt,stderr_excerpt,text_available,failed_initialization_phase,
       child_process,sandbox_denial,temporary_directory_identity,working_directory_identity,
       environment_variable_names,local_secret_scan,server_secret_scan,diagnostic_hash,provenance_message_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41)
     ON CONFLICT(workspace_id,execution_id,execution_attempt,provider_attempt_id) DO NOTHING
     RETURNING diagnostic_id`,
    [
      credential.workspace_id,
      diagnosticId,
      diagnostic.schemaVersion,
      message.missionId,
      message.taskId,
      message.executionId,
      message.attempt,
      authority.assignment_id,
      authority.participant_assignment_id,
      authority.role,
      credential.agent_id,
      diagnostic.provider,
      diagnostic.requestedModel,
      diagnostic.cliVersion,
      diagnostic.runtimeProfileId,
      diagnostic.runtimeProfileHash,
      diagnostic.sandboxProfileHash,
      diagnostic.providerAttemptId,
      authority.lease_owner,
      Number(authority.fencing_token),
      diagnostic.processStartedAt,
      diagnostic.processTerminatedAt,
      diagnostic.exitCode,
      diagnostic.terminationSignal,
      diagnostic.timedOut,
      diagnostic.cancellationRequested,
      diagnostic.stdoutHash,
      diagnostic.stderrHash,
      diagnostic.stdoutExcerpt,
      diagnostic.stderrExcerpt,
      diagnostic.textAvailable,
      diagnostic.failedInitializationPhase,
      JSON.stringify(diagnostic.childProcess),
      JSON.stringify(diagnostic.sandboxDenial),
      diagnostic.temporaryDirectoryIdentity,
      diagnostic.workingDirectoryIdentity,
      JSON.stringify(diagnostic.environmentVariableNames),
      diagnostic.localSecretScan,
      serverSecretScan,
      diagnosticHash,
      message.messageId,
    ],
  );
  if (!inserted.rowCount) {
    const existing = (
      await getDatabasePool().query<{
        diagnostic_id: string;
        diagnostic_hash: string;
        provenance_message_id: string;
      }>(
        `SELECT diagnostic_id,diagnostic_hash,provenance_message_id
         FROM provider_runtime_diagnostics
         WHERE workspace_id=$1 AND execution_id=$2 AND execution_attempt=$3 AND provider_attempt_id=$4`,
        [credential.workspace_id, message.executionId, message.attempt, diagnostic.providerAttemptId],
      )
    ).rows[0];
    if (!existing || existing.diagnostic_id !== diagnosticId || existing.diagnostic_hash !== diagnosticHash)
      throw new ValidationFailedError("Provider diagnostic attempt identity was reused with different evidence");
  }
  await handleExecutionFact({
    actor: actor(credential),
    commandId: stableUuid(
      `remote:${message.executionId}:${message.attempt}:provider-diagnostic:${diagnostic.providerAttemptId}`,
    ),
    executionId: message.executionId!,
    type: "execution.provider_diagnostic_recorded",
    payload: {
      diagnosticId,
      diagnosticSchemaVersion: diagnostic.schemaVersion,
      diagnosticHash,
      provider: diagnostic.provider,
      requestedModel: diagnostic.requestedModel,
      runtimeProfileId: diagnostic.runtimeProfileId,
      runtimeProfileHash: diagnostic.runtimeProfileHash,
      sandboxProfileHash: diagnostic.sandboxProfileHash,
      providerAttemptId: diagnostic.providerAttemptId,
      serverSecretScan,
      textAvailable: diagnostic.textAvailable,
    },
  });
  return diagnostic;
}

async function persistProviderRuntimeDiagnosticWithoutBlockingTerminalState(
  message: ProtocolEnvelope,
  credential: Credential,
) {
  const diagnostics = Array.isArray(message.payload.providerDiagnostics)
    ? message.payload.providerDiagnostics
    : message.payload.providerDiagnostic === undefined
      ? []
      : [message.payload.providerDiagnostic];
  if (!diagnostics.length) return;
  try {
    if (diagnostics.length > maximumProviderRuntimeDiagnosticHistory)
      throw new ValidationFailedError("Provider diagnostic history is too large");
    for (let index = 0; index < diagnostics.length; index += 1) {
      const attemptId = String((diagnostics[index] as Record<string, unknown>)?.providerAttemptId ?? "");
      if (attemptId !== `${message.attempt}-${index + 1}`)
        throw new ValidationFailedError("Provider diagnostic attempts must be unique and contiguous");
      await persistProviderRuntimeDiagnostic(message, credential, diagnostics[index]);
    }
  } catch {
    // A malformed or stale diagnostic is never allowed to strand an execution in
    // a non-terminal state. Record only a content hash; do not echo attacker-
    // controlled diagnostic text into events or logs.
    try {
      await handleExecutionFact({
        actor: actor(credential),
        commandId: stableUuid(`remote:${message.messageId}:provider-diagnostic-rejected`),
        executionId: message.executionId!,
        type: "execution.provider_diagnostic_rejected",
        payload: {
          diagnosticEnvelopeHash: canonicalHash(diagnostics),
          reason: "invalid_or_stale_runtime_binding",
        },
      });
    } catch {
      // Terminal execution handling remains authoritative even if the database
      // cannot accept the supplementary rejection fact.
    }
  }
}

async function persistSuccessfulProviderRuntimeDiagnostics(message: ProtocolEnvelope, credential: Credential) {
  const values = message.payload.providerDiagnostics;
  const requiresProviderEvidence = Boolean(
    (
      await getDatabasePool().query<{ required: boolean }>(
        `SELECT (payload ? 'approvedPlan' OR
                 (payload ? 'consensus' AND payload#>>'{consensus,operation}' <> 'prepare_context')) required
         FROM pull_assignments WHERE workspace_id=$1 AND execution_id=$2 AND agent_id=$3`,
        [credential.workspace_id, message.executionId, credential.agent_id],
      )
    ).rows[0]?.required,
  );
  if (values === undefined) {
    if (requiresProviderEvidence)
      throw new ValidationFailedError("Consensus provider success requires complete invocation diagnostics");
    return;
  }
  if (!requiresProviderEvidence && Array.isArray(values) && values.length === 0) return;
  if (!Array.isArray(values) || values.length < 1 || values.length > maximumProviderRuntimeDiagnosticHistory)
    throw new ValidationFailedError("Successful provider diagnostic evidence is invalid");
  const attemptIds = new Set<string>();
  let finalDiagnostic;
  for (let index = 0; index < values.length; index += 1) {
    const attemptId = String((values[index] as Record<string, unknown>)?.providerAttemptId ?? "");
    if (attemptId !== `${message.attempt}-${index + 1}` || attemptIds.has(attemptId))
      throw new ValidationFailedError("Successful provider diagnostic attempts must be unique and contiguous");
    attemptIds.add(attemptId);
    finalDiagnostic = await persistProviderRuntimeDiagnostic(message, credential, values[index]);
  }
  if (
    !finalDiagnostic ||
    finalDiagnostic.exitCode !== 0 ||
    finalDiagnostic.failedInitializationPhase !== "none" ||
    finalDiagnostic.timedOut ||
    finalDiagnostic.cancellationRequested
  )
    throw new ValidationFailedError("Successful provider execution lacks a terminal successful diagnostic");
}
export async function enforceRemoteContextVerification(
  current: {
    context_checksum: string | null;
    starting_sha: string | null;
    agent_verification_status: string | null;
  },
  payload: Record<string, unknown>,
  onMismatch: () => Promise<void>,
) {
  if (!current.context_checksum || current.agent_verification_status === "verified") return undefined;
  const evidence = {
    received: String(payload.receivedContextChecksum ?? ""),
    verified: String(payload.verifiedContextChecksum ?? ""),
    outcome: String(payload.contextVerificationOutcome ?? ""),
    startingSha: String(payload.startingSha ?? ""),
  };
  if (
    evidence.received !== current.context_checksum ||
    evidence.verified !== current.context_checksum ||
    evidence.outcome !== "verified" ||
    evidence.startingSha !== current.starting_sha
  ) {
    await onMismatch();
    throw new ValidationFailedError("Remote agent Project Brain context verification failed");
  }
  return evidence;
}
async function transition(
  message: ProtocolEnvelope,
  credential: Credential,
  target: Parameters<typeof handleExecutionTransition>[0]["target"],
  suffix: string = target,
) {
  return handleExecutionTransition({
    actor: actor(credential),
    commandId: stableUuid(`remote:${message.messageId}:${suffix}`),
    executionId: message.executionId!,
    target,
    details: message.payload,
  });
}

async function assertRepositoryMutationAuthority(
  message: ProtocolEnvelope,
  credential: Credential,
  authorityFromMessage: boolean,
) {
  const task = (
    await getDatabasePool().query<{
      approval_requirements: Record<string, unknown>;
      approved_plan_artifact_id: string | null;
      approved_plan_hash: string | null;
      parent_consensus_mission_id: string | null;
      repository_id: string | null;
      repository_snapshot: string | null;
      base_commit: string | null;
      base_branch: string | null;
      verification_requirements: unknown[];
      repository_authority_hash: string | null;
      bound_repository_authority_hash: string | null;
      write_allowed: boolean;
      commit_allowed: boolean;
      isolated_worktree_write_allowed: boolean;
      mission_agent_local_commit_allowed: boolean;
      provider_direct_commit_allowed: boolean;
      push_allowed: boolean;
      pull_request_allowed: boolean;
      merge_allowed: boolean;
      publication_allowed: boolean;
      deployment_allowed: boolean;
      infrastructure_mutation_allowed: boolean;
    }>(
      `SELECT t.approval_requirements,t.verification_requirements,m.approved_plan_artifact_id,m.approved_plan_hash,
        m.parent_consensus_mission_id,m.repository_id,m.repository_snapshot,m.base_commit,m.base_branch,
        r.repository_authority_hash,c.repository_authority_hash bound_repository_authority_hash,
        r.write_allowed,r.commit_allowed,
        r.isolated_worktree_write_allowed,r.mission_agent_local_commit_allowed,r.provider_direct_commit_allowed,
        r.push_allowed,r.pull_request_allowed,r.merge_allowed,r.publication_allowed,r.deployment_allowed,r.infrastructure_mutation_allowed
       FROM task_projections t JOIN mission_projections m
         ON m.workspace_id=t.workspace_id AND m.mission_id=t.mission_id
       LEFT JOIN repositories r ON r.workspace_id=m.workspace_id AND r.repository_id=m.repository_id
       LEFT JOIN consensus_plan_projections c ON c.workspace_id=m.workspace_id AND c.mission_id=m.parent_consensus_mission_id
       WHERE t.workspace_id=$1 AND t.task_id=$2`,
      [credential.workspace_id, message.taskId],
    )
  ).rows[0];
  let approvalId = String(message.payload.approvalId ?? "");
  let actionHash = String(message.payload.actionHash ?? "");
  if (!authorityFromMessage) {
    const resumed = (
      await getDatabasePool().query<{ approval_id: string; action_hash: string }>(
        `SELECT payload->>'approvalId' approval_id,payload->>'actionHash' action_hash
         FROM events WHERE workspace_id=$1 AND aggregate_type='execution' AND aggregate_id=$2
           AND event_type='execution.approval_decision_acknowledged' AND payload ? 'approvalId'
         ORDER BY aggregate_version DESC LIMIT 1`,
        [credential.workspace_id, message.executionId],
      )
    ).rows[0];
    approvalId = resumed?.approval_id ?? "";
    actionHash = resumed?.action_hash ?? "";
  }
  const remote = task?.parent_consensus_mission_id
    ? undefined
    : (
        await getDatabasePool().query<{ approval_id: string; action_hash: string }>(
          `SELECT approval_id,action_hash FROM approval_projections
           WHERE workspace_id=$1 AND approval_id=NULLIF($2,'')::uuid AND execution_id=$3 AND agent_id=$4
             AND approval_type='remote_workflow' AND status='granted'
             AND requested_action->>'actionType'='repository.modify'
             AND (expires_at IS NULL OR expires_at>now())`,
          [credential.workspace_id, approvalId, message.executionId, credential.agent_id],
        )
      ).rows[0];
  if (remote && remote.action_hash === actionHash) return remote;
  if (!task || task.approval_requirements?.missionType !== "change")
    throw new ValidationFailedError("Execution cannot resume without the exact granted approval");
  if (!task.parent_consensus_mission_id)
    throw new ValidationFailedError("Remote execution cannot complete without an unexpired repository.modify approval");
  const consensusApprovalId = String(task.approval_requirements.humanApprovalId ?? "");
  const consensus = (
    await getDatabasePool().query<{
      approval_id: string;
      action_hash: string;
      requested_action: Record<string, unknown>;
    }>(
      `SELECT approval_id,action_hash,requested_action FROM approval_projections
       WHERE workspace_id=$1 AND approval_id=$2 AND approval_type='consensus_plan' AND status='granted'`,
      [credential.workspace_id, consensusApprovalId],
    )
  ).rows[0];
  const action = consensus?.requested_action;
  const exactEffects = ["worktree.create", "worktree.write", "validation.run", "git.commit_local"];
  const exactProhibitions = [
    "git.commit_provider",
    "git.push",
    "pull_request.create",
    "repository.merge",
    "repository.publish",
    "deployment.execute",
    "infrastructure.mutate",
  ];
  if (
    !consensus ||
    approvalId !== consensus.approval_id ||
    actionHash !== consensus.action_hash ||
    action?.actionType !== "repository.modify" ||
    action.authoritySource !== "consensus_plan" ||
    action.missionId !== task.parent_consensus_mission_id ||
    action.childMissionId !== message.missionId ||
    action.repositoryId !== task.repository_id ||
    action.repositorySnapshot !== task.repository_snapshot ||
    action.baseBranch !== task.base_branch ||
    action.repositoryBaseCommit !== task.base_commit ||
    action.repositoryAuthorityHash !== task.repository_authority_hash ||
    task.approval_requirements.repositoryAuthorityHash !== task.repository_authority_hash ||
    task.repository_authority_hash !== task.bound_repository_authority_hash ||
    task.write_allowed ||
    task.commit_allowed ||
    !task.isolated_worktree_write_allowed ||
    !task.mission_agent_local_commit_allowed ||
    task.provider_direct_commit_allowed ||
    task.push_allowed ||
    task.pull_request_allowed ||
    task.merge_allowed ||
    task.publication_allowed ||
    task.deployment_allowed ||
    task.infrastructure_mutation_allowed ||
    action.contextPackHash !== task.approval_requirements.contextPackHash ||
    action.canonicalPlanArtifactId !== task.approved_plan_artifact_id ||
    action.canonicalPlanHash !== task.approved_plan_hash ||
    action.executorAgentId !== credential.agent_id ||
    action.executorModelId !== task.approval_requirements.executorModelId ||
    action.executorProviderId !== task.approval_requirements.executorProviderId ||
    action.executorAssignmentId !== task.approval_requirements.executorAssignmentId ||
    action.capabilityAttestationId !== task.approval_requirements.capabilityAttestationId ||
    action.capabilityAttestationHash !== task.approval_requirements.capabilityAttestationHash ||
    action.permissionProfileHash !== task.approval_requirements.permissionProfileHash ||
    !action.executionBudget ||
    !task.approval_requirements.executionBudget ||
    canonicalHash(action.executionBudget) !== canonicalHash(task.approval_requirements.executionBudget) ||
    canonicalHash(action.validationCommands) !== canonicalHash(task.verification_requirements) ||
    canonicalHash(action.validationCommands) !== canonicalHash(task.approval_requirements.validationCommands) ||
    JSON.stringify(action.authorizedEffects) !== JSON.stringify(exactEffects) ||
    JSON.stringify(action.prohibitedEffects) !== JSON.stringify(exactProhibitions)
  ) {
    throw new ValidationFailedError("Repository mutation authority is missing, stale, or does not match the child");
  }
  return consensus;
}

async function persistConsensusValidationReceipt(
  message: ProtocolEnvelope,
  credential: Credential,
  database: AuthorityQueryClient = getDatabasePool(),
) {
  const executionAuthority = await validateExecutionAuthorityPresentation(message, credential, database);
  const task = (
    await database.query<{
      parent_consensus_mission_id: string | null;
      base_commit: string | null;
      approved_plan_hash: string | null;
      approval_requirements: Record<string, unknown>;
      verification_requirements: unknown[];
    }>(
      `SELECT m.parent_consensus_mission_id,m.base_commit,m.approved_plan_hash,
         t.approval_requirements,t.verification_requirements
       FROM task_projections t JOIN mission_projections m
         ON m.workspace_id=t.workspace_id AND m.mission_id=t.mission_id
       WHERE t.workspace_id=$1 AND t.task_id=$2`,
      [credential.workspace_id, message.taskId],
    )
  ).rows[0];
  if (!task?.parent_consensus_mission_id) return undefined;
  const commitId = String(message.payload.commitId ?? "");
  const baseCommit = String(message.payload.baseCommit ?? "");
  if (!/^[0-9a-f]{40,64}$/.test(commitId) || baseCommit !== task.base_commit || commitId === baseCommit)
    throw new ValidationFailedError(
      "Consensus implementation success requires exact base and resulting commit evidence",
    );
  const evidence = await getDatabasePool().query<{
    artifact_id: string;
    kind: string;
    checksum_sha256: string;
    metadata: Record<string, unknown>;
  }>(
    `SELECT artifact_id,kind,checksum_sha256,metadata FROM artifacts
     WHERE workspace_id=$1 AND execution_id=$2 AND deleted_at IS NULL
       AND kind=ANY($3::text[]) ORDER BY created_at`,
    [
      credential.workspace_id,
      message.executionId,
      ["implementation_plan", "git_patch", "validation_results", "change_summary"],
    ],
  );
  const requiredKinds = ["implementation_plan", "git_patch", "validation_results", "change_summary"];
  const byKind = new Map(evidence.rows.map((artifact) => [artifact.kind, artifact]));
  if (
    evidence.rows.length !== requiredKinds.length ||
    requiredKinds.some((kind) => !byKind.has(kind)) ||
    evidence.rows.some(
      (artifact) =>
        Number(artifact.metadata.partCount ?? 1) !== 1 ||
        artifact.metadata.completeChecksum !== artifact.checksum_sha256,
    )
  )
    throw new ValidationFailedError(
      "Consensus implementation success requires one complete plan, patch, validation, and summary artifact",
    );
  const planArtifact = byKind.get("implementation_plan")!;
  const patchArtifact = byKind.get("git_patch")!;
  const validationArtifact = byKind.get("validation_results")!;
  const summaryArtifact = byKind.get("change_summary")!;
  if (
    planArtifact.metadata.repositoryCommit !== baseCommit ||
    patchArtifact.metadata.repositoryCommit !== baseCommit ||
    validationArtifact.metadata.repositoryCommit !== baseCommit ||
    summaryArtifact.metadata.repositoryCommit !== commitId
  )
    throw new ValidationFailedError("Consensus implementation artifacts are not bound to the base and result commits");
  const assignment = (
    await database.query<{
      participant_assignment_id: string;
      agent_id: string;
      provider_id: string;
      model_id: string;
      capability_attestation_id: string;
      capability_attestation_hash: string;
      permission_profile_hash: string;
    }>(
      `SELECT participant_assignment_id,agent_id,provider_id,model_id,capability_attestation_id,
         capability_attestation_hash,permission_profile_hash
       FROM consensus_participant_assignments
       WHERE workspace_id=$1 AND mission_id=$2 AND role='executor'`,
      [credential.workspace_id, task.parent_consensus_mission_id],
    )
  ).rows[0];
  if (!assignment || assignment.agent_id !== credential.agent_id)
    throw new ValidationFailedError(
      "Consensus implementation success is not bound to the approved executor assignment",
    );
  const lease = (
    await database.query<{
      lease_owner: string;
      fencing_token: string;
      attempt: number;
      status: string;
    }>(
      `SELECT lease_owner,fencing_token::text,attempt,status FROM pull_assignments
       WHERE workspace_id=$1 AND execution_id=$2 AND agent_id=$3`,
      [credential.workspace_id, message.executionId, credential.agent_id],
    )
  ).rows[0];
  if (!lease?.lease_owner || !["leased", "acknowledged"].includes(lease.status))
    throw new ValidationFailedError("Consensus validation receipt requires the active fenced assignment lease");
  const validationCommandIdentities = (task.verification_requirements ?? []).map((command) =>
    canonicalHash(String(command).split(/\s+/)),
  );
  if (!validationCommandIdentities.length)
    throw new ValidationFailedError(
      "Consensus implementation success requires at least one governed validation command",
    );
  const receipt = {
    validationReceiptId: stableUuid(`consensus-validation-receipt:${message.executionId}:${message.attempt}`),
    missionId: message.missionId,
    parentConsensusMissionId: task.parent_consensus_mission_id,
    taskId: message.taskId,
    executionId: message.executionId,
    executionAttempt: message.attempt,
    participantAssignmentId: assignment.participant_assignment_id,
    agentId: assignment.agent_id,
    providerId: assignment.provider_id,
    modelId: assignment.model_id,
    capabilityAttestationId: assignment.capability_attestation_id,
    capabilityAttestationHash: assignment.capability_attestation_hash,
    permissionProfileHash: assignment.permission_profile_hash,
    baseCommit,
    resultCommit: commitId,
    canonicalPlanHash: task.approved_plan_hash,
    patchArtifactId: patchArtifact.artifact_id,
    patchChecksum: patchArtifact.checksum_sha256,
    validationArtifactId: validationArtifact.artifact_id,
    validationChecksum: validationArtifact.checksum_sha256,
    summaryArtifactId: summaryArtifact.artifact_id,
    summaryChecksum: summaryArtifact.checksum_sha256,
    validationCommandIdentities,
    completedAt: message.sentAt,
    leaseOwner: lease.lease_owner,
    fencingToken: Number(lease.fencing_token),
    provenanceMessageId: message.messageId,
    runtimeModelIdentity: String(message.payload.runtimeModelIdentity ?? "unverifiable"),
    requestedModelId: assignment.model_id,
    actualModelId: message.payload.actualModelId ? String(message.payload.actualModelId) : null,
    executionAuthorityPresentation: executionAuthority.presentation,
    executionAuthorityPresentationSha256: executionAuthority.presentationSha256,
  };
  if (
    (receipt.actualModelId !== null && receipt.actualModelId !== assignment.model_id) ||
    !["verified", "reported", "unverifiable"].includes(receipt.runtimeModelIdentity) ||
    (receipt.runtimeModelIdentity === "verified" && receipt.actualModelId === null)
  )
    throw new ValidationFailedError("Provider completion runtime-model evidence does not match the assigned model");
  const receiptHash = canonicalHash(receipt);
  if (message.payload.validationReceiptHash !== receiptHash)
    throw new ValidationFailedError("Consensus validation receipt hash does not match the authenticated evidence");
  const inserted = await database.query<{ receipt_hash: string }>(
    `INSERT INTO consensus_execution_validation_receipts(
       workspace_id,validation_receipt_id,mission_id,parent_consensus_mission_id,task_id,execution_id,
       execution_attempt,participant_assignment_id,agent_id,provider_id,model_id,capability_attestation_id,
       capability_attestation_hash,permission_profile_hash,base_commit,result_commit,canonical_plan_hash,patch_artifact_id,patch_checksum,
       validation_artifact_id,validation_checksum,summary_artifact_id,summary_checksum,
       validation_command_identities,completed_at,lease_owner,fencing_token,provenance_message_id,
       runtime_model_identity,requested_model_id,actual_model_id,execution_authority_presentation,
       execution_authority_presentation_sha256,receipt_hash
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34)
     ON CONFLICT(workspace_id,execution_id,execution_attempt) DO NOTHING
     RETURNING receipt_hash`,
    [
      credential.workspace_id,
      receipt.validationReceiptId,
      receipt.missionId,
      receipt.parentConsensusMissionId,
      receipt.taskId,
      receipt.executionId,
      receipt.executionAttempt,
      receipt.participantAssignmentId,
      receipt.agentId,
      receipt.providerId,
      receipt.modelId,
      receipt.capabilityAttestationId,
      receipt.capabilityAttestationHash,
      receipt.permissionProfileHash,
      receipt.baseCommit,
      receipt.resultCommit,
      receipt.canonicalPlanHash,
      receipt.patchArtifactId,
      receipt.patchChecksum,
      receipt.validationArtifactId,
      receipt.validationChecksum,
      receipt.summaryArtifactId,
      receipt.summaryChecksum,
      JSON.stringify(receipt.validationCommandIdentities),
      receipt.completedAt,
      receipt.leaseOwner,
      receipt.fencingToken,
      receipt.provenanceMessageId,
      receipt.runtimeModelIdentity,
      receipt.requestedModelId,
      receipt.actualModelId,
      JSON.stringify(receipt.executionAuthorityPresentation),
      receipt.executionAuthorityPresentationSha256,
      receiptHash,
    ],
  );
  const persistedHash =
    inserted.rows[0]?.receipt_hash ??
    (
      await database.query<{ receipt_hash: string }>(
        `SELECT receipt_hash FROM consensus_execution_validation_receipts
         WHERE workspace_id=$1 AND execution_id=$2 AND execution_attempt=$3`,
        [credential.workspace_id, receipt.executionId, receipt.executionAttempt],
      )
    ).rows[0]?.receipt_hash;
  assertConsensusValidationReceiptAuthority(persistedHash, receiptHash);
  return { ...receipt, receiptHash };
}

async function persistConsensusValidationReceiptWithAuthorityFence(message: ProtocolEnvelope, credential: Credential) {
  // The pull-message route holds acquireExecutionLeaseFence for this assignment
  // across processAuthenticatedMessage. Reacquiring the same session lock from a
  // second pool connection would self-deadlock; validation and persistence run
  // inside the already-held authority fence.
  return persistConsensusValidationReceipt(message, credential);
}

export function assertConsensusValidationReceiptAuthority(
  persistedReceiptSha256: string | undefined,
  submittedReceiptSha256: string,
) {
  if (persistedReceiptSha256 !== submittedReceiptSha256)
    throw new ValidationFailedError("Existing consensus validation receipt does not match authenticated evidence", {
      reason_code: "CONFLICTING_RECEIPT_REJECTED",
    });
}

export function assertRemoteExecutionOutputAuthority(input: {
  status: string;
  cancellationRequestedAt: Date | null;
  outputFencedAt: Date | null;
  outputFenceReason: string | null;
  messageType: string;
}) {
  if (["succeeded", "failed", "timed_out", "cancelled"].includes(input.status))
    throw new ValidationFailedError(`Execution is terminal (${input.status}); delayed provider output is rejected`, {
      reason_code: "DELAYED_PROVIDER_OUTPUT_REJECTED",
    });
  if (
    (input.cancellationRequestedAt || input.outputFencedAt) &&
    !["ExecutionFailed", "ExecutionCancellationAcknowledged"].includes(input.messageType)
  )
    throw new ValidationFailedError(
      `Execution output is fenced (${input.outputFenceReason ?? "cancellation_requested"}); delayed provider output is rejected`,
      { reason_code: "DELAYED_PROVIDER_OUTPUT_REJECTED" },
    );
}

export async function processRemoteMessage(message: ProtocolEnvelope, credential: Credential) {
  if (String(message.messageType).startsWith("RemoteProjectBrain"))
    return processRemoteProjectBrainMessage(message, credential.workspace_id);
  if (message.messageType === "ApprovalDecisionAcknowledged") {
    const approvalId = String(message.payload.approvalId ?? "");
    const approval = await loadAggregateEvents({
      workspaceId: credential.workspace_id,
      aggregateType: "approval",
      aggregateId: approvalId,
    });
    const requested = approval.find((event) => event.eventType === "approval.requested");
    if (!requested || requested.payload.agentId !== credential.agent_id)
      throw new ValidationFailedError("Approval acknowledgement is not authorized");
    await appendEvents({
      workspaceId: credential.workspace_id,
      aggregateType: "approval",
      aggregateId: approvalId,
      missionId: requested.missionId,
      expectedVersion: approval.length,
      commandId: stableUuid(`remote:${message.messageId}:approval-ack`),
      commandType: "AcknowledgeRemoteApprovalDecision",
      correlationId: requested.correlationId,
      causationId: approval.at(-1)?.eventId,
      actor: { type: "agent", id: credential.agent_id },
      events: [
        {
          eventType: "approval.decision_acknowledged",
          eventSchemaVersion: 1,
          payload: {
            status: approval.at(-1)?.payload.status,
            agentId: credential.agent_id,
            messageId: message.messageId,
          },
        },
      ],
      applyProjections: applyApprovalProjection,
    });
    return { status: "acknowledged", approvalId };
  }
  if (message.messageType === "AgentHeartbeat" || message.messageType === "AgentCapabilitiesReported") {
    // Heartbeats carry a complete runtime trust presentation. Reading every prior
    // presentation makes the request cost grow with the lifetime of the agent and
    // can exceed the client's bounded deadline. Only the aggregate head is needed
    // for optimistic concurrency and causation at this append boundary.
    const aggregateHead = await loadAggregateHead({
      workspaceId: credential.workspace_id,
      aggregateType: "agent",
      aggregateId: credential.agent_id,
    });
    const eventType =
      message.messageType === "AgentHeartbeat" ? "agent.heartbeat_received" : "agent.capabilities_reported";
    const pullReady = message.messageType === "AgentHeartbeat" && message.payload.assignmentPull === true;
    const credentialVerified =
      message.messageType === "AgentHeartbeat" && credential.credential_record_status === "pending_verification";
    const projectBrainCapabilities =
      message.payload.projectBrain === undefined
        ? undefined
        : validateRemoteProjectBrainCapabilities(message.payload.projectBrain);
    const artifactVerification = verifyMissionAgentArtifact(
      message.payload.missionAgentVersion,
      message.payload.artifact,
    );
    const artifactPresentationBinding = {
      schemaVersion: "artifact-presentation-verified/1",
      workspaceId: credential.workspace_id,
      agentId: credential.agent_id,
      provider: (message.payload.providerProfile as { provider?: unknown } | undefined)?.provider ?? null,
      protocolVersion: message.protocolVersion,
      missionAgentVersion: message.payload.missionAgentVersion ?? null,
      artifact: message.payload.artifact ?? null,
      runtimeProfileIdentity: canonicalHash(message.payload.providerProfile ?? null),
      runtimeBindingIdentity: canonicalHash(message.payload.providerRuntimeStatus ?? null),
      runtimeTrust: artifactVerification.runtimeTrust,
      disposablePacketIdentity: canonicalHash(artifactVerification.disposablePacket ?? null),
    };
    const priorArtifactPresentation = await getDatabasePool().query<{ payload: unknown }>(
      `SELECT payload FROM events
        WHERE workspace_id=$1 AND aggregate_type='agent' AND aggregate_id=$2
          AND event_type='agent.artifact_presentation_verified'
        ORDER BY aggregate_version DESC
        LIMIT 1`,
      [credential.workspace_id, credential.agent_id],
    );
    const hasPriorArtifactPresentation = latestArtifactPresentationMatches(
      priorArtifactPresentation.rows.map((row) => row.payload),
      artifactPresentationBinding,
    );
    const projectBrainCompatible =
      artifactVerification.compatible &&
      !!projectBrainCapabilities?.installed &&
      !!projectBrainCapabilities.runtimeReady &&
      projectBrainCapabilities.coreVersion === "0.4.0" &&
      projectBrainCapabilities.contractVersions.includes("1.0") &&
      projectBrainCapabilities.schemaVersions.includes("2.5.0");
    await appendEvents({
      workspaceId: credential.workspace_id,
      aggregateType: "agent",
      aggregateId: credential.agent_id,
      expectedVersion: aggregateHead.version,
      commandId: stableUuid(`remote:${message.messageId}`),
      commandType: message.messageType,
      correlationId: message.correlationId,
      causationId: aggregateHead.eventId ?? undefined,
      actor: { type: "agent", id: credential.agent_id },
      events: [
        {
          eventType,
          eventSchemaVersion: 1,
          occurredAt: message.sentAt,
          payload: { ...message.payload, serverRuntimeTrust: artifactVerification.runtimeTrust },
        },
        ...(message.payload.artifact
          ? [
              ...(projectBrainCapabilities
                ? [
                    {
                      eventType: "agent.remote_project_brain_capability_advertised",
                      eventSchemaVersion: 1,
                      occurredAt: message.sentAt,
                      payload: { capabilities: projectBrainCapabilities },
                    },
                  ]
                : []),
              {
                eventType:
                  artifactVerification.status === "verified"
                    ? "agent.mission_agent_artifact_checksum_verified"
                    : "agent.mission_agent_artifact_checksum_rejected",
                eventSchemaVersion: 1,
                payload: {
                  advertisedVersion: String(message.payload.missionAgentVersion ?? ""),
                  advertisedChecksum: artifactVerification.advertisedChecksum,
                  expectedChecksum: artifactVerification.expectedChecksum,
                  manifestVersion: artifactVerification.manifestVersion,
                  status: artifactVerification.status,
                  rejectionReason: artifactVerification.rejectionReason,
                  projectBrainCompatible,
                  identityProtocolVersion: artifactVerification.identityProtocolVersion,
                  runtimeTrust: artifactVerification.runtimeTrust,
                  disposablePacket: hasPriorArtifactPresentation ? undefined : artifactVerification.disposablePacket,
                },
              },
              ...(!hasPriorArtifactPresentation && artifactVerification.status === "verified"
                ? [
                    {
                      eventType: "agent.artifact_presentation_verified",
                      eventSchemaVersion: 1,
                      occurredAt: message.sentAt,
                      payload: artifactPresentationVerificationMarker(artifactPresentationBinding, message.messageId),
                    },
                  ]
                : []),
            ]
          : []),
        ...(pullReady
          ? [
              {
                eventType: "agent.pull_ready_confirmed",
                eventSchemaVersion: 1,
                occurredAt: message.sentAt,
                payload: {
                  missionAgentVersion: message.payload.missionAgentVersion,
                  adapter: message.payload.adapter,
                  protocolVersion: message.protocolVersion,
                },
              },
            ]
          : []),
        ...(credentialVerified
          ? [
              {
                eventType: "agent.credential_verified",
                eventSchemaVersion: 1,
                occurredAt: message.sentAt,
                payload: { credentialId: credential.credential_id },
              },
            ]
          : []),
      ],
      applyProjections: async (client, appended) => {
        await applyMissionAgentCapabilityProjection(client, appended);
        const last = appended.at(-1)!;
        const capabilityObservedAt =
          appended.find((item) =>
            [
              "agent.mission_agent_artifact_checksum_verified",
              "agent.mission_agent_artifact_checksum_rejected",
            ].includes(item.eventType),
          )?.occurredAt ?? last.occurredAt;
        if (eventType === "agent.heartbeat_received") {
          const advertisedProfile = message.payload.providerProfile
            ? parseAgentProviderProfile(message.payload.providerProfile)
            : undefined;
          if (advertisedProfile) {
            const runtimeStatus = message.payload.providerRuntimeStatus
              ? parseProviderRuntimeStatus(message.payload.providerRuntimeStatus, advertisedProfile.provider)
              : undefined;
            if (
              ["codex", "claude_code"].includes(advertisedProfile.provider) &&
              /^0\.(?:[89]|[1-9][0-9])\./.test(String(message.payload.missionAgentVersion ?? "")) &&
              !runtimeStatus
            )
              throw new ValidationFailedError("Mission Agent 0.8 or later must report provider runtime readiness");
            const approved = (
              await client.query<{
                provider_id: string;
                agent_version: string | null;
                supported_mission_roles: string[];
                supported_operations: string[];
                supported_models: string[];
                model_capabilities: Array<Record<string, unknown>>;
                capability_attestation_id: string | null;
                capability_attestation_hash: string | null;
                capability_attestation_revoked_at: Date | null;
                capability_attestation_version: number | null;
                capability_source: string | null;
                structured_output: boolean;
                project_brain_context: boolean;
                repository_mutation: boolean;
                provider_runtime_requirements_id: string | null;
                provider_runtime_requirements_hash: string | null;
              }>(
                `SELECT a.provider_id,a.agent_version,a.supported_mission_roles,a.supported_operations,
                  a.supported_models,a.model_capabilities,a.capability_attestation_id,
                  a.capability_attestation_hash,ca.revoked_at capability_attestation_revoked_at,
                  a.capability_attestation_version,a.capability_source,
                  structured_output,project_brain_context,repository_mutation,
                  a.provider_runtime_requirements_id,a.provider_runtime_requirements_hash
                 FROM agents a
                 LEFT JOIN agent_model_capability_attestations ca
                   ON ca.workspace_id=a.workspace_id
                  AND ca.capability_attestation_id=a.capability_attestation_id
                 WHERE a.workspace_id=$1 AND a.agent_id=$2`,
                [credential.workspace_id, credential.agent_id],
              )
            ).rows[0];
            if (
              !approved ||
              approved.provider_id !== advertisedProfile.provider ||
              approved.agent_version !== advertisedProfile.agentVersion ||
              advertisedProfile.supportedMissionRoles.length !== approved.supported_mission_roles.length ||
              advertisedProfile.supportedMissionRoles.some(
                (role) => !approved.supported_mission_roles.includes(role),
              ) ||
              advertisedProfile.supportedOperations.length !== approved.supported_operations.length ||
              advertisedProfile.supportedOperations.some(
                (operation) => !approved.supported_operations.includes(operation),
              ) ||
              advertisedProfile.supportedModels.length !== approved.supported_models.length ||
              advertisedProfile.supportedModels.some((model) => !approved.supported_models.includes(model)) ||
              canonicalHash(advertisedProfile.modelCapabilities) !== canonicalHash(approved.model_capabilities) ||
              advertisedProfile.capabilityAttestationVersion !== approved.capability_attestation_version ||
              advertisedProfile.capabilitySource !== approved.capability_source ||
              advertisedProfile.structuredOutput !== approved.structured_output ||
              advertisedProfile.projectBrainContext !== approved.project_brain_context ||
              advertisedProfile.repositoryMutation !== approved.repository_mutation ||
              advertisedProfile.runtimeRequirements?.requirementsId !== approved.provider_runtime_requirements_id ||
              advertisedProfile.runtimeRequirements?.requirementsHash !== approved.provider_runtime_requirements_hash
            )
              throw new ValidationFailedError("Agent provider profile exceeds its owner-approved registration");
            const attestationHash = canonicalHash({
              agentId: credential.agent_id,
              provider: advertisedProfile.provider,
              agentVersion: advertisedProfile.agentVersion,
              missionAgentArtifactChecksum: artifactVerification.advertisedChecksum,
              attestationVersion: advertisedProfile.capabilityAttestationVersion,
              capabilitySource: advertisedProfile.capabilitySource,
              supportedModels: advertisedProfile.supportedModels,
              modelCapabilities: advertisedProfile.modelCapabilities,
              runtimeRequirements: advertisedProfile.runtimeRequirements,
              runtimeProfiles: runtimeStatus?.runtimeProfiles ?? [],
              serverRuntimeTrust: artifactVerification.runtimeTrust,
              disposablePacket: artifactVerification.disposablePacket,
            });
            if (approved.capability_attestation_revoked_at)
              throw new ValidationFailedError("Agent capability attestation has been revoked");
            const renewsCurrentAttestation =
              approved.capability_attestation_id !== null && approved.capability_attestation_hash === attestationHash;
            const attestationId = renewsCurrentAttestation
              ? approved.capability_attestation_id!
              : stableUuid(`agent-model-capability:${message.messageId}`);
            const expiresAt = new Date(Date.parse(last.occurredAt) + 5 * 60_000).toISOString();
            if (renewsCurrentAttestation) {
              const renewed = await client.query(
                `UPDATE agent_model_capability_attestations
                 SET expires_at=$4
                 WHERE workspace_id=$1 AND capability_attestation_id=$2 AND attestation_hash=$3
                   AND revoked_at IS NULL`,
                [credential.workspace_id, attestationId, attestationHash, expiresAt],
              );
              if (renewed.rowCount !== 1)
                throw new ValidationFailedError("Agent capability attestation renewal was rejected");
            } else
              await client.query(
                `INSERT INTO agent_model_capability_attestations(
                   workspace_id,capability_attestation_id,agent_id,provider_id,agent_version,
                   mission_agent_artifact_checksum,attestation_version,capability_source,supported_models,
                   model_capabilities,provider_runtime_requirements_id,provider_runtime_requirements_hash,
                   provider_runtime_profiles,runtime_mode,trust_authority,acceptance_registry_path,
                   acceptance_registry_path_hash,acceptance_registry_hash,disposable_packet,
                   attestation_hash,advertised_at,expires_at
                 ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
                [
                  credential.workspace_id,
                  attestationId,
                  credential.agent_id,
                  advertisedProfile.provider,
                  advertisedProfile.agentVersion,
                  artifactVerification.advertisedChecksum,
                  advertisedProfile.capabilityAttestationVersion,
                  advertisedProfile.capabilitySource,
                  JSON.stringify(advertisedProfile.supportedModels),
                  JSON.stringify(advertisedProfile.modelCapabilities),
                  advertisedProfile.runtimeRequirements!.requirementsId,
                  advertisedProfile.runtimeRequirements!.requirementsHash,
                  JSON.stringify(runtimeStatus?.runtimeProfiles ?? []),
                  artifactVerification.runtimeTrust.runtimeMode,
                  artifactVerification.runtimeTrust.trustAuthority,
                  artifactVerification.runtimeTrust.registryPath,
                  artifactVerification.runtimeTrust.registryPathHash,
                  artifactVerification.runtimeTrust.registryContentHash,
                  artifactVerification.disposablePacket ? JSON.stringify(artifactVerification.disposablePacket) : null,
                  attestationHash,
                  last.occurredAt,
                  expiresAt,
                ],
              );
            await client.query(
              `UPDATE agents SET agent_version=$3,capability_attestation_id=$4,
                 capability_attestation_hash=$5,capability_attested_at=$6,
                 capability_attestation_expires_at=$7,provider_runtime_requirements_id=$8,
                 provider_runtime_requirements_hash=$9,provider_runtime_status=$10,
                 provider_runtime_profiles=$11,provider_runtime_requirements_satisfied=$12
               WHERE workspace_id=$1 AND agent_id=$2`,
              [
                credential.workspace_id,
                credential.agent_id,
                advertisedProfile.agentVersion,
                attestationId,
                attestationHash,
                last.occurredAt,
                expiresAt,
                advertisedProfile.runtimeRequirements!.requirementsId,
                advertisedProfile.runtimeRequirements!.requirementsHash,
                JSON.stringify(runtimeStatus ?? {}),
                JSON.stringify(runtimeStatus?.runtimeProfiles ?? []),
                runtimeStatus ? providerRuntimeStatusSatisfies(advertisedProfile.provider, runtimeStatus) : false,
              ],
            );
          }
          await client.query(
            `UPDATE agents SET last_heartbeat_at=$3,status=CASE WHEN status='disabled' THEN status ELSE 'active' END,
             pull_ready_at=CASE WHEN $4 THEN $3 ELSE pull_ready_at END,
             mission_agent_version=CASE WHEN $4 THEN $5 ELSE mission_agent_version END,
             mission_agent_adapter=CASE WHEN $4 THEN $6 ELSE mission_agent_adapter END,
             provider_credentials_available=$7,updated_at=$3
             WHERE workspace_id=$1 AND agent_id=$2`,
            [
              credential.workspace_id,
              credential.agent_id,
              last.occurredAt,
              pullReady,
              pullReady ? String(message.payload.missionAgentVersion ?? "unknown") : null,
              pullReady ? String(message.payload.adapter ?? "generic") : null,
              message.payload.providerCredentialsAvailable === true,
            ],
          );
          if (message.payload.artifact)
            await client.query(
              `UPDATE agents SET remote_project_brain_capabilities=$3,
                remote_project_brain_capabilities_at=$4::timestamptz,
                mission_agent_artifact_checksum=$5,mission_agent_expected_checksum=$6,
                mission_agent_checksum_status=$7,mission_agent_manifest_version=$8,
                mission_agent_project_brain_compatible=$9,
                mission_agent_checksum_rejection_reason=$10,
                mission_agent_artifact_verified_at=CASE WHEN $11 THEN $4::timestamptz ELSE NULL END,
                mission_agent_capability_expires_at=$4::timestamptz + interval '5 minutes',
                mission_agent_runtime_mode=$12,mission_agent_trust_authority=$13,
                mission_agent_acceptance_registry_path=$14,
                mission_agent_acceptance_registry_path_hash=$15,
                mission_agent_acceptance_registry_hash=$16,
                mission_agent_disposable_packet=CASE
                  WHEN $17::jsonb IS NULL THEN mission_agent_disposable_packet
                  ELSE $17::jsonb
                END,
                updated_at=$4::timestamptz
               WHERE workspace_id=$1 AND agent_id=$2`,
              [
                credential.workspace_id,
                credential.agent_id,
                projectBrainCapabilities ? JSON.stringify(projectBrainCapabilities) : null,
                capabilityObservedAt,
                artifactVerification.advertisedChecksum,
                artifactVerification.expectedChecksum,
                artifactVerification.status,
                artifactVerification.manifestVersion,
                projectBrainCompatible,
                artifactVerification.rejectionReason,
                artifactVerification.compatible,
                artifactVerification.runtimeTrust.runtimeMode,
                artifactVerification.runtimeTrust.trustAuthority,
                artifactVerification.runtimeTrust.registryPath,
                artifactVerification.runtimeTrust.registryPathHash,
                artifactVerification.runtimeTrust.registryContentHash,
                !hasPriorArtifactPresentation && artifactVerification.disposablePacket
                  ? JSON.stringify(artifactVerification.disposablePacket)
                  : null,
              ],
            );
          await client.query(
            `INSERT INTO agent_heartbeats(workspace_id,agent_id,credential_id,protocol_version,received_at,reported_at) VALUES($1,$2,$3,'1.0',now(),$4) ON CONFLICT(workspace_id,agent_id) DO UPDATE SET credential_id=EXCLUDED.credential_id,protocol_version=EXCLUDED.protocol_version,received_at=EXCLUDED.received_at,reported_at=EXCLUDED.reported_at`,
            [credential.workspace_id, credential.agent_id, credential.credential_id, message.sentAt],
          );
          await client.query(
            "UPDATE agent_credentials SET last_used_at=now(),status=CASE WHEN credential_id=$3 AND status='pending_verification' THEN 'active' ELSE status END,verified_at=CASE WHEN credential_id=$3 AND status='pending_verification' THEN now() ELSE verified_at END WHERE workspace_id=$1 AND agent_id=$2 AND credential_id=$3",
            [credential.workspace_id, credential.agent_id, credential.credential_id],
          );
          if (credentialVerified)
            await client.query(
              "UPDATE agents SET credential_status='active',updated_at=now() WHERE workspace_id=$1 AND agent_id=$2",
              [credential.workspace_id, credential.agent_id],
            );
        } else if (Array.isArray(message.payload.capabilities)) {
          const allowed = (
            await client.query<{ capabilities: string[] }>(
              "SELECT capabilities FROM agents WHERE workspace_id=$1 AND agent_id=$2",
              [credential.workspace_id, credential.agent_id],
            )
          ).rows[0]?.capabilities;
          if (
            !allowed ||
            !message.payload.capabilities.every(
              (capability) => typeof capability === "string" && allowed.includes(capability),
            )
          )
            throw new ValidationFailedError("Agent cannot advertise capabilities outside its owner-approved set");
          await client.query(
            "UPDATE agents SET capabilities=$3,updated_at=now() WHERE workspace_id=$1 AND agent_id=$2",
            [credential.workspace_id, credential.agent_id, JSON.stringify(message.payload.capabilities)],
          );
        }
      },
    });
    return { status: "accepted", eventType };
  }
  const current = await executionRow(message, credential.workspace_id);
  if (
    current.context_checksum &&
    ["ExecutionArtifactSubmitted", "ExecutionSucceeded"].includes(message.messageType) &&
    current.agent_verification_status !== "verified"
  )
    throw new ValidationFailedError(
      "Project Brain context checksum must be verified before artifacts or execution success are accepted",
    );
  assertRemoteExecutionOutputAuthority({
    status: current.status,
    cancellationRequestedAt: current.cancellation_requested_at,
    outputFencedAt: current.output_fenced_at,
    outputFenceReason: current.output_fence_reason,
    messageType: message.messageType,
  });
  switch (message.messageType) {
    case "ExecutionAccepted":
      await transition(message, credential, "accepted");
      await handleTaskTransition({
        actor: actor(credential),
        commandId: stableUuid(`remote:${message.messageId}:task-running`),
        taskId: message.taskId!,
        target: "running",
        details: { assignedExecutor: message.agentId },
      });
      return { status: "accepted" };
    case "ExecutionRejected":
      await transition(message, credential, "failed");
      return { status: "rejected" };
    case "ExecutionHeartbeat": {
      if (current.status === "accepted") await transition(message, credential, "preparing", "preparing");
      await handleExecutionFact({
        actor: actor(credential),
        commandId: stableUuid(`remote:${message.messageId}:heartbeat`),
        executionId: message.executionId!,
        type: "execution.progress_reported",
        payload: { ...message.payload, heartbeat: true },
      });
      await getDatabasePool().query(
        `INSERT INTO execution_heartbeats(
          workspace_id,execution_id,agent_id,worker_id,stage,command_summary,
          progress_percent,progress_message,received_at,lease_expires_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now(),now()+interval '90 seconds')
        ON CONFLICT(workspace_id,execution_id) DO UPDATE SET
          agent_id=excluded.agent_id,worker_id=excluded.worker_id,stage=excluded.stage,
          command_summary=excluded.command_summary,progress_percent=excluded.progress_percent,
          progress_message=excluded.progress_message,received_at=excluded.received_at,
          lease_expires_at=excluded.lease_expires_at`,
        [
          credential.workspace_id,
          message.executionId,
          credential.agent_id,
          String(message.payload.workerId ?? credential.agent_id).slice(0, 200),
          String(message.payload.stage ?? current.status ?? "running").slice(0, 100),
          message.payload.commandSummary ? String(message.payload.commandSummary).slice(0, 500) : null,
          Number.isInteger(message.payload.progressPercent) ? Number(message.payload.progressPercent) : null,
          message.payload.summary ? String(message.payload.summary).slice(0, 1000) : null,
        ],
      );
      await getDatabasePool().query(
        "UPDATE execution_projections SET last_heartbeat_at=now() WHERE workspace_id=$1 AND execution_id=$2",
        [credential.workspace_id, message.executionId],
      );
      return { status: "accepted" };
    }
    case "ExecutionProgressReported": {
      if (message.payload.filesystemWriteAuthority !== undefined)
        await validateFilesystemWriteAuthority(message, credential, message.payload.filesystemWriteAuthority);
      if (message.payload.filesystemWriteObservation !== undefined) {
        const observation = message.payload.filesystemWriteObservation as Record<string, unknown> & {
          evidenceSeal?: { algorithm?: string; subjectSha256?: string };
          allowedWrite?: { allowed?: boolean; existsAfter?: boolean };
          deniedWrite?: {
            allowed?: boolean;
            reasonCode?: string;
            canonicalTargetPath?: string;
            existedBefore?: boolean;
            existsAfter?: boolean;
            targetSha256Before?: string | null;
            targetSha256After?: string | null;
          };
          descendantWrite?: {
            attempted?: boolean;
            allowed?: boolean;
            targetExistsAfter?: boolean;
            reasonCode?: string;
          };
        };
        const authority = await validateFilesystemWriteAuthority(message, credential, observation.authority);
        const registered = (
          await getDatabasePool().query<{ authority_sha256: string }>(
            `SELECT payload#>>'{filesystemWriteAuthority,authoritySha256}' authority_sha256
               FROM events WHERE workspace_id=$1 AND aggregate_id=$2
                 AND event_type='execution.progress_reported'
                 AND payload#>>'{filesystemWriteAuthority,providerAttemptId}'=$3
               ORDER BY position DESC LIMIT 1`,
            [credential.workspace_id, message.executionId, observation.providerAttemptId],
          )
        ).rows[0];
        assertFilesystemWriteObservationBinding({
          observation,
          authority,
          registeredAuthoritySha256: registered?.authority_sha256 ?? null,
          workspaceId: credential.workspace_id,
          missionId: String(message.missionId ?? ""),
          executionId: String(message.executionId ?? ""),
          assignmentId: String(current.assignment_id ?? ""),
          assignmentAttempt: Number(message.attempt),
        });
      }
      if (message.payload.retryEvidence !== undefined) {
        const diagnostics = message.payload.providerDiagnostics;
        if (!Array.isArray(diagnostics) || diagnostics.length !== 1)
          throw new ValidationFailedError("Provider retry progress requires exactly one diagnostic");
        const diagnostic = await persistProviderRuntimeDiagnostic(message, credential, diagnostics[0]);
        const retry = message.payload.retryEvidence as Record<string, unknown>;
        if (
          !diagnostic ||
          retry.assignmentId !== current.assignment_id ||
          retry.assignmentAttempt !== message.attempt ||
          retry.providerAttemptId !== diagnostic.providerAttemptId ||
          retry.retryOrdinal !== diagnostic.retryOrdinal ||
          retry.retryLimit !== diagnostic.retryLimit ||
          retry.failureCategory !== diagnostic.failureCategory ||
          retry.failureStatus !== diagnostic.failureStatus ||
          retry.retryDecision !== diagnostic.retryDecision ||
          retry.retryCommandId !== diagnostic.retryCommandId ||
          retry.replacementProviderAttemptId !== diagnostic.replacementProviderAttemptId
        )
          throw new ValidationFailedError("Provider retry evidence does not match its durable diagnostic");
      }
      await persistActiveProviderAttempt({
        message,
        workspaceId: credential.workspace_id,
        agentId: credential.agent_id,
      });
      await persistAuthorityLocalStateObservation({
        message,
        workspaceId: credential.workspace_id,
        agentId: credential.agent_id,
      });
      if (current.context_checksum && current.agent_verification_status !== "verified") {
        const evidence = await enforceRemoteContextVerification(current, message.payload, async () => {
          await transition(
            {
              ...message,
              payload: {
                classification: "context_verification_failed",
                retryDisposition: "requires-human-review",
                stage: "project_brain_context_verification",
                summary: "Remote agent did not verify the bound Project Brain context",
              },
            },
            credential,
            "failed",
            "context-mismatch",
          );
        });
        const received = evidence!.received;
        const verified = evidence!.verified;
        const startingSha = evidence!.startingSha;
        const operation = (
          await getDatabasePool().query<{ operation_id: string }>(
            `SELECT operation_id FROM project_brain_operation_projections
             WHERE workspace_id=$1 AND mission_id=$2 AND operation='prepare_context' AND status='succeeded'
             ORDER BY completed_at DESC LIMIT 1`,
            [credential.workspace_id, message.missionId],
          )
        ).rows[0];
        if (operation)
          await appendEvents({
            workspaceId: credential.workspace_id,
            aggregateType: "project_brain_operation",
            aggregateId: operation.operation_id,
            missionId: message.missionId,
            expectedVersion: (
              await loadAggregateEvents({
                workspaceId: credential.workspace_id,
                aggregateType: "project_brain_operation",
                aggregateId: operation.operation_id,
              })
            ).at(-1)!.aggregateVersion,
            commandId: stableUuid(`remote:${message.messageId}:context-verified`),
            commandType: "VerifyRemoteProjectBrainContext",
            correlationId: message.missionId!,
            actor: { type: "agent", id: credential.agent_id },
            events: [
              {
                eventType: "project_brain.context_verified_by_agent",
                eventSchemaVersion: 1,
                payload: {
                  repositoryId: current.repository_id,
                  operation: "prepare_context",
                  operationStatus: "succeeded",
                  contextChecksum: verified,
                  startingSha,
                  missionProjection: {
                    agentReceivedChecksum: received,
                    agentVerifiedChecksum: verified,
                    agentVerificationStatus: "verified",
                    verifiedAt: message.sentAt,
                  },
                },
              },
            ],
            applyProjections: applyProjectBrainProjection,
          });
      }
      if (current.status === "accepted") {
        await transition(message, credential, "preparing", "preparing");
        await transition(message, credential, "running", "running");
      } else if (current.status === "preparing") await transition(message, credential, "running", "running");
      await handleExecutionFact({
        actor: actor(credential),
        commandId: stableUuid(`remote:${message.messageId}:progress`),
        executionId: message.executionId!,
        type: "execution.progress_reported",
        payload: message.payload,
      });
      return { status: "accepted" };
    }
    case "ExecutionArtifactSubmitted": {
      if (current.status === "accepted") {
        await transition(message, credential, "preparing", "preparing");
        await transition(message, credential, "running", "running");
      } else if (current.status === "preparing") await transition(message, credential, "running", "running");
      const content = String(message.payload.contentBase64 ?? ""),
        body = Buffer.from(content, "base64");
      if (!content || body.byteLength > 128 * 1024)
        throw new ValidationFailedError("Inline artifact is missing or oversized");
      if (message.payload.checksum !== sha256(new Uint8Array(body)))
        throw new ValidationFailedError("Submitted artifact checksum does not match content");
      const artifactKind = String(message.payload.artifactType ?? "report");
      const consensusArtifact = consensusArtifactKinds.includes(artifactKind as ConsensusArtifactKind);
      if (consensusArtifact) {
        assertConsensusArtifactSecretSafe(body);
        if (artifactKind !== "project_brain_context_pack")
          parseConsensusArtifact(artifactKind as ConsensusArtifactKind, body);
      }
      const parsedRecommendations =
        artifactKind === "repository_recommendations" ? parseRepositoryRecommendations(body) : undefined;
      const parsedHealth =
        artifactKind === "repository_health_observations" ? parseRepositoryHealthObservations(body) : undefined;
      const recoveredArtifact = (
        await getDatabasePool().query<{
          artifact_id: string;
          kind: string;
          byte_size: string;
          checksum_sha256: string;
        }>(
          `SELECT artifact_id,kind,byte_size::text,checksum_sha256 FROM artifacts
           WHERE workspace_id=$1 AND execution_id=$2 AND metadata->>'messageId'=$3 AND deleted_at IS NULL`,
          [credential.workspace_id, message.executionId, message.messageId],
        )
      ).rows[0];
      if (recoveredArtifact && recoveredArtifact.checksum_sha256 !== message.payload.checksum)
        throw new ValidationFailedError("Recovered artifact checksum does not match the authenticated message");
      const artifact = recoveredArtifact
        ? {
            artifactId: recoveredArtifact.artifact_id,
            kind: recoveredArtifact.kind,
            byteSize: Number(recoveredArtifact.byte_size),
            checksum: recoveredArtifact.checksum_sha256,
          }
        : await storeExecutionArtifact({
            workspaceId: credential.workspace_id,
            missionId: message.missionId!,
            taskId: message.taskId!,
            executionId: message.executionId!,
            kind: artifactKind,
            mediaType: String(message.payload.mediaType ?? "text/markdown"),
            body,
            metadata: {
              name: message.payload.name,
              description: message.payload.description,
              source: "remote-agent",
              messageId: message.messageId,
              repositoryCommit: message.payload.repositoryCommit ?? null,
              partNumber: message.payload.partNumber ?? 1,
              partCount: message.payload.partCount ?? 1,
              completeChecksum: message.payload.completeChecksum ?? message.payload.checksum,
            },
          });
      try {
        if (consensusArtifact)
          await recordConsensusArtifact({
            actor: actor(credential),
            messageId: message.messageId,
            missionId: message.missionId!,
            taskId: message.taskId!,
            executionId: message.executionId!,
            artifactId: artifact.artifactId,
            artifactKind,
            artifactChecksum: artifact.checksum,
            body,
          });
        await handleExecutionFact({
          actor: actor(credential),
          commandId: stableUuid(`remote:${message.messageId}:artifact`),
          executionId: message.executionId!,
          type: "execution.artifact_produced",
          payload: {
            artifactId: artifact.artifactId,
            kind: artifact.kind,
            byteSize: artifact.byteSize,
            checksum: artifact.checksum,
          },
        });
      } catch (error) {
        await getDatabasePool().query(
          "UPDATE artifacts SET deleted_at=now() WHERE workspace_id=$1 AND artifact_id=$2 AND deleted_at IS NULL",
          [credential.workspace_id, artifact.artifactId],
        );
        throw error;
      }
      if (artifact.kind === "repository_recommendations") {
        if (!current.repository_id) throw new ValidationFailedError("Recommendation artifact requires a repository");
        await recordRepositoryRecommendations({
          actor: actor(credential),
          commandId: stableUuid(`remote:${message.messageId}:recommendations`),
          repositoryId: current.repository_id,
          sourceMissionId: message.missionId!,
          sourceExecutionId: message.executionId!,
          sourceArtifactId: artifact.artifactId,
          recommendations: parsedRecommendations!,
        });
      }
      if (artifact.kind === "repository_health_observations") {
        if (!current.repository_id) throw new ValidationFailedError("Repository health artifact requires a repository");
        await recordRepositoryHealthAssessment({
          actor: actor(credential),
          commandId: stableUuid(`remote:${message.messageId}:repository-health`),
          repositoryId: current.repository_id,
          sourceMissionId: message.missionId!,
          sourceExecutionId: message.executionId!,
          sourceArtifactId: artifact.artifactId,
          repositoryCommit: message.payload.repositoryCommit
            ? String(message.payload.repositoryCommit).slice(0, 100)
            : undefined,
          observations: parsedHealth!,
        });
      }
      return { status: "accepted", artifactId: artifact.artifactId };
    }
    case "ExecutionApprovalRequested": {
      const consensusChild = await getDatabasePool().query(
        `SELECT 1 FROM mission_projections m
         WHERE m.workspace_id=$1 AND m.mission_id=$2 AND m.parent_consensus_mission_id IS NOT NULL`,
        [credential.workspace_id, message.missionId],
      );
      if (consensusChild.rowCount)
        throw new ValidationFailedError(
          "Consensus implementation children must use the exact inherited consensus approval and cannot request another approval",
        );
      const requested = await requestRemoteApproval({
        workspaceId: credential.workspace_id,
        missionId: message.missionId!,
        taskId: message.taskId!,
        executionId: message.executionId!,
        agentId: message.agentId,
        messageId: message.messageId,
        actionType: String(message.payload.actionType ?? ""),
        parameters: (message.payload.parameters as Record<string, unknown>) ?? {},
        targetResource: String(message.payload.targetResource ?? "mission"),
        riskExplanation: String(message.payload.riskExplanation ?? "Remote workflow decision requested"),
        evidence: Array.isArray(message.payload.evidence) ? message.payload.evidence : [],
        expiresAt: String(message.payload.expiresAt ?? new Date(Date.now() + 15 * 60_000).toISOString()),
      });
      if (requested.outcome === "deny") {
        await handleExecutionFact({
          actor: actor(credential),
          commandId: stableUuid(`remote:${message.messageId}:approval-denied`),
          executionId: message.executionId!,
          type: "execution.remote_approval_denied",
          payload: {
            actionType: message.payload.actionType,
            actionHash: requested.actionHash,
            policy: requested.decision,
          },
        });
        return { status: "denied", policy: requested.decision };
      }
      await transition(message, credential, "waiting_for_approval");
      await handleTaskTransition({
        actor: actor(credential),
        commandId: stableUuid(`remote:${message.messageId}:task-waiting`),
        taskId: message.taskId!,
        target: "waiting_for_approval",
        details: { approvalId: requested.approvalId },
      });
      return { status: "approval_required", approvalId: requested.approvalId };
    }
    case "ExecutionPaused":
      await transition(message, credential, "paused");
      return { status: "accepted" };
    case "ExecutionResumed": {
      await assertRepositoryMutationAuthority(message, credential, true);
      if (current.status === "accepted") {
        await transition(message, credential, "preparing", "preparing-after-authority");
        await transition(message, credential, "running", "running-after-authority");
      } else if (current.status === "preparing")
        await transition(message, credential, "running", "running-after-authority");
      else await transition(message, credential, "running");
      await handleExecutionFact({
        actor: actor(credential),
        commandId: stableUuid(`remote:${message.messageId}:authority-acknowledged`),
        executionId: message.executionId!,
        type: "execution.approval_decision_acknowledged",
        payload: {
          approvalId: message.payload.approvalId,
          actionHash: message.payload.actionHash,
          authoritySource: "consensus_plan",
        },
      });
      await handleTaskTransition({
        actor: actor(credential),
        commandId: stableUuid(`remote:${message.messageId}:task-resumed`),
        taskId: message.taskId!,
        target: "running",
        details: { approvalDecision: "granted" },
      });
      return { status: "accepted" };
    }
    case "ExecutionSucceeded": {
      await persistSuccessfulProviderRuntimeDiagnostics(message, credential);
      const taskAuthority = (
        await getDatabasePool().query<{ approval_requirements: Record<string, unknown> }>(
          "SELECT approval_requirements FROM task_projections WHERE workspace_id=$1 AND task_id=$2",
          [credential.workspace_id, message.taskId],
        )
      ).rows[0]?.approval_requirements;
      if (taskAuthority?.missionType === "change") {
        await assertRepositoryMutationAuthority(message, credential, false);
        await persistConsensusValidationReceiptWithAuthorityFence(message, credential);
      }
      if (current.delivery_mode === "pull") {
        const artifactCount = await getDatabasePool().query<{ count: number }>(
          "SELECT count(*)::int count FROM artifacts WHERE workspace_id=$1 AND execution_id=$2 AND deleted_at IS NULL",
          [credential.workspace_id, message.executionId],
        );
        if (!artifactCount.rows[0]?.count)
          throw new ValidationFailedError("Pull execution cannot complete without a verified artifact");
      }
      const latest = (
        await getDatabasePool().query<{ status: string }>(
          "SELECT status FROM execution_projections WHERE workspace_id=$1 AND execution_id=$2",
          [credential.workspace_id, message.executionId],
        )
      ).rows[0]?.status;
      if (latest === "accepted") {
        await transition(message, credential, "preparing", "preparing");
        await transition(message, credential, "running", "running");
      } else if (latest === "preparing") await transition(message, credential, "running", "running");
      await transition(message, credential, "verifying", "verifying");
      const usage = message.payload.usage;
      if (usage && typeof usage === "object" && !Array.isArray(usage)) {
        const dimensions = (
          await getDatabasePool().query<{
            provider_id: string;
            participant_assignment_id: string | null;
            role: string | null;
            operation: string | null;
            model_id: string | null;
          }>(
            `SELECT COALESCE(p.provider_id,a.provider_id) provider_id,p.participant_assignment_id,p.role,t.operation,p.model_id
             FROM agents a JOIN execution_projections e
               ON e.workspace_id=a.workspace_id AND e.execution_id=$3
             JOIN mission_projections m ON m.workspace_id=e.workspace_id AND m.mission_id=e.mission_id
             LEFT JOIN consensus_turns t ON t.workspace_id=a.workspace_id AND t.execution_id=$3
             LEFT JOIN consensus_participant_assignments p ON p.workspace_id=a.workspace_id AND (
               p.participant_assignment_id=t.participant_assignment_id OR
               (m.parent_consensus_mission_id IS NOT NULL AND p.mission_id=m.parent_consensus_mission_id AND p.role='executor')
             )
             WHERE a.workspace_id=$1 AND a.agent_id=$2`,
            [credential.workspace_id, credential.agent_id, message.executionId],
          )
        ).rows[0];
        const report = usage as Record<string, unknown>;
        if (report.model && dimensions?.model_id && String(report.model) !== dimensions.model_id)
          throw new ValidationFailedError("Provider usage model does not match the immutable assignment");
        if (
          report.requestedPrimaryModel !== undefined &&
          dimensions?.model_id &&
          String(report.requestedPrimaryModel) !== dimensions.model_id
        )
          throw new ValidationFailedError("Provider telemetry primary model does not match the immutable assignment");
        const auxiliaryModels = report.observedAuxiliaryModels;
        if (auxiliaryModels !== undefined) {
          if (!Array.isArray(auxiliaryModels) || auxiliaryModels.length > 8)
            throw new ValidationFailedError("Provider auxiliary-model telemetry is invalid");
          for (let index = 0; index < auxiliaryModels.length; index += 1) {
            const entry = auxiliaryModels[index];
            if (!entry || typeof entry !== "object" || Array.isArray(entry))
              throw new ValidationFailedError("Provider auxiliary-model telemetry is invalid");
            const auxiliary = entry as Record<string, unknown>;
            const auxiliaryModelId = String(auxiliary.modelId ?? "");
            if (
              !/^[a-z0-9][a-z0-9._:/-]{0,127}$/.test(auxiliaryModelId) ||
              auxiliaryModelId === dimensions?.model_id ||
              auxiliary.source !== "provider_telemetry" ||
              auxiliary.independentlyVerified !== false
            )
              throw new ValidationFailedError("Provider auxiliary-model identity is invalid");
            const auxiliaryUsage =
              auxiliary.usage && typeof auxiliary.usage === "object" && !Array.isArray(auxiliary.usage)
                ? (auxiliary.usage as Record<string, unknown>)
                : undefined;
            await recordUsage({
              workspaceId: credential.workspace_id,
              commandId: stableUuid(`remote-usage:${message.messageId}:auxiliary:${index}`),
              actorId: credential.agent_id,
              actorType: "agent",
              missionId: message.missionId,
              taskId: message.taskId,
              executionId: message.executionId,
              agentId: message.agentId,
              provider: dimensions?.provider_id ?? "remote_agent",
              runtime: String(report.runtime ?? "remote_http"),
              model: auxiliaryModelId,
              participantAssignmentId: dimensions?.participant_assignment_id ?? undefined,
              assignmentRole: dimensions?.role ?? undefined,
              planningPhase: dimensions?.operation ?? undefined,
              executionAttempt: current.attempt,
              metricType: "auxiliary_model_activity",
              quantity: 1,
              unit: "provider_reported_invocations",
              costAmount:
                Number.isFinite(Number(auxiliaryUsage?.costAmount)) && Number(auxiliaryUsage?.costAmount) >= 0
                  ? Number(auxiliaryUsage?.costAmount)
                  : undefined,
              currency: auxiliaryUsage?.currency ? String(auxiliaryUsage.currency) : undefined,
              costConfidence: "provider_reported",
              source: "provider_telemetry_unverified_auxiliary",
            });
          }
        }
        for (const [metricType, unit] of [
          ["inputTokens", "tokens"],
          ["outputTokens", "tokens"],
          ["toolCalls", "calls"],
          ["externalDataCalls", "calls"],
          ["durationMs", "milliseconds"],
        ] as const) {
          const quantity = Number(report[metricType]);
          if (Number.isFinite(quantity) && quantity >= 0)
            await recordUsage({
              workspaceId: credential.workspace_id,
              commandId: stableUuid(`remote-usage:${message.messageId}:${metricType}`),
              actorId: credential.agent_id,
              actorType: "agent",
              missionId: message.missionId,
              taskId: message.taskId,
              executionId: message.executionId,
              agentId: message.agentId,
              provider: dimensions?.provider_id ?? "remote_agent",
              runtime: String(report.runtime ?? "remote_http"),
              model: dimensions?.model_id ?? undefined,
              participantAssignmentId: dimensions?.participant_assignment_id ?? undefined,
              assignmentRole: dimensions?.role ?? undefined,
              planningPhase: dimensions?.operation ?? undefined,
              executionAttempt: current.attempt,
              metricType,
              quantity,
              unit,
              costConfidence: "provider_reported",
              source: "authenticated_remote_agent",
            });
        }
        const cost = Number(report.costAmount);
        if (Number.isFinite(cost) && cost >= 0)
          await recordUsage({
            workspaceId: credential.workspace_id,
            commandId: stableUuid(`remote-usage:${message.messageId}:cost`),
            actorId: credential.agent_id,
            actorType: "agent",
            missionId: message.missionId,
            taskId: message.taskId,
            executionId: message.executionId,
            agentId: message.agentId,
            provider: dimensions?.provider_id ?? "remote_agent",
            runtime: String(report.runtime ?? "remote_http"),
            model: dimensions?.model_id ?? undefined,
            participantAssignmentId: dimensions?.participant_assignment_id ?? undefined,
            assignmentRole: dimensions?.role ?? undefined,
            planningPhase: dimensions?.operation ?? undefined,
            executionAttempt: current.attempt,
            metricType: "cost",
            quantity: cost,
            unit: String(report.currency ?? "USD"),
            costAmount: cost,
            currency: String(report.currency ?? "USD"),
            costConfidence: "provider_reported",
            source: "authenticated_remote_agent",
          });
        else
          await recordUsage({
            workspaceId: credential.workspace_id,
            commandId: stableUuid(`remote-usage:${message.messageId}:cost-unknown`),
            actorId: credential.agent_id,
            actorType: "agent",
            missionId: message.missionId,
            taskId: message.taskId,
            executionId: message.executionId,
            agentId: message.agentId,
            provider: dimensions?.provider_id ?? "remote_agent",
            runtime: String(report.runtime ?? "remote_http"),
            model: dimensions?.model_id ?? undefined,
            participantAssignmentId: dimensions?.participant_assignment_id ?? undefined,
            assignmentRole: dimensions?.role ?? undefined,
            planningPhase: dimensions?.operation ?? undefined,
            executionAttempt: current.attempt,
            metricType: "cost",
            costConfidence: "unknown",
            source: "authenticated_remote_agent",
          });
      }
      await transition(message, credential, "succeeded", "succeeded");
      await handleTaskTransition({
        actor: actor(credential),
        commandId: stableUuid(`remote:${message.messageId}:task-verifying`),
        taskId: message.taskId!,
        target: "verifying",
        details: { verificationSummary: "Remote execution reported success" },
      });
      await handleTaskTransition({
        actor: actor(credential),
        commandId: stableUuid(`remote:${message.messageId}:task-complete`),
        taskId: message.taskId!,
        target: "completed",
        details: { outputSummary: message.payload.summary },
      });
      await coordinateAfterTask(credential.workspace_id, message.missionId!, message.taskId!, "task.completed");
      return { status: "completed" };
    }
    case "ExecutionFailed":
      await persistProviderRuntimeDiagnosticWithoutBlockingTerminalState(message, credential);
      if (message.payload.classification === "project_brain_context_stale") {
        const operation = (
          await getDatabasePool().query<{ operation_id: string }>(
            `SELECT operation_id FROM project_brain_operation_projections
             WHERE workspace_id=$1 AND mission_id=$2 AND operation='prepare_context' AND status='succeeded'
             ORDER BY completed_at DESC LIMIT 1`,
            [credential.workspace_id, message.missionId],
          )
        ).rows[0];
        if (operation)
          await appendEvents({
            workspaceId: credential.workspace_id,
            aggregateType: "project_brain_operation",
            aggregateId: operation.operation_id,
            missionId: message.missionId,
            expectedVersion: (
              await loadAggregateEvents({
                workspaceId: credential.workspace_id,
                aggregateType: "project_brain_operation",
                aggregateId: operation.operation_id,
              })
            ).at(-1)!.aggregateVersion,
            commandId: stableUuid(`remote:${message.messageId}:context-stale`),
            commandType: "InvalidateRemoteProjectBrainContext",
            correlationId: message.missionId!,
            actor: { type: "agent", id: credential.agent_id },
            events: [
              {
                eventType: "project_brain.remote_repository_head_changed",
                eventSchemaVersion: 1,
                payload: {
                  repositoryId: current.repository_id,
                  operation: "prepare_context",
                  operationStatus: "succeeded",
                  expectedSha: message.payload.expectedStartingSha,
                  observedSha: message.payload.observedStartingSha,
                  missionProjection: { contextBoundStatus: "stale" },
                },
              },
            ],
            applyProjections: applyProjectBrainProjection,
          });
      }
      await transition(message, credential, "failed");
      for (const row of (
        await getDatabasePool().query<{ approval_id: string }>(
          "SELECT approval_id FROM approval_projections WHERE workspace_id=$1 AND execution_id=$2 AND status='pending'",
          [credential.workspace_id, message.executionId],
        )
      ).rows)
        await expireApproval({
          workspaceId: credential.workspace_id,
          approvalId: row.approval_id,
          actorId: "terminal-execution-cleanup",
        });
      await handleTaskTransition({
        actor: actor(credential),
        commandId: stableUuid(`remote:${message.messageId}:task-failed`),
        taskId: message.taskId!,
        target: "failed",
        details: message.payload,
      });
      await coordinateAfterTask(credential.workspace_id, message.missionId!, message.taskId!, "task.failed");
      return { status: "failed" };
    case "ExecutionCancellationAcknowledged":
      await persistProviderRuntimeDiagnosticWithoutBlockingTerminalState(message, credential);
      await transition(message, credential, "cancelled");
      await handleTaskTransition({
        actor: actor(credential),
        commandId: stableUuid(`remote:${message.messageId}:task-cancelled`),
        taskId: message.taskId!,
        target: "cancelled",
        details: { reason: "remote_execution_cancelled" },
      });
      await coordinateAfterTask(credential.workspace_id, message.missionId!, message.taskId!, "task.cancelled");
      return { status: "cancelled" };
    default:
      throw new ValidationFailedError(`${message.messageType} is not enabled in the first remote-agent slice`);
  }
}

export function parseRepositoryRecommendations(body: Buffer) {
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    throw new ValidationFailedError("Recommendation artifact must be valid JSON");
  }
  if (!Array.isArray(value)) throw new ValidationFailedError("Recommendation artifact must contain an array");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new ValidationFailedError("Recommendation entry is invalid");
    const row = item as Record<string, unknown>;
    const evidenceEntries = Array.isArray(row.evidence)
      ? row.evidence
      : row.evidence && typeof row.evidence === "object"
        ? [row.evidence]
        : [];
    const evidence = evidenceEntries.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        throw new ValidationFailedError("Recommendation evidence is invalid");
      const e = entry as Record<string, unknown>;
      const path = String(e.path ?? "").trim();
      if (!path || path.startsWith("/") || path.includes(".."))
        throw new ValidationFailedError("Recommendation evidence path is unsafe");
      return {
        path,
        ...(Number.isInteger(e.line) && Number(e.line) > 0 ? { line: Number(e.line) } : {}),
        ...(e.description ? { description: String(e.description).slice(0, 500) } : {}),
      };
    });
    const validationEntries = Array.isArray(row.suggestedValidation)
      ? row.suggestedValidation
      : typeof row.suggestedValidation === "string"
        ? [row.suggestedValidation]
        : [];
    const acceptanceEntries = Array.isArray(row.acceptanceCriteria)
      ? row.acceptanceCriteria
      : typeof row.acceptanceCriteria === "string"
        ? [row.acceptanceCriteria]
        : [];
    const validation = validationEntries
      .map(String)
      .map((entry) => entry.trim())
      .filter(Boolean);
    const acceptance = acceptanceEntries
      .map(String)
      .map((entry) => entry.trim())
      .filter(Boolean);
    const impact = String(row.estimatedImpact ?? "medium");
    const risk = String(row.estimatedRisk ?? "medium");
    if (
      !(["low", "medium", "high", "critical"] as string[]).includes(impact) ||
      !(["low", "medium", "high"] as string[]).includes(risk)
    )
      throw new ValidationFailedError("Recommendation impact or risk is invalid");
    return {
      title: String(row.title ?? "").slice(0, 200),
      description: String(row.description ?? "").slice(0, 2000),
      reasoning: String(row.reasoning ?? "").slice(0, 3000),
      evidence,
      estimatedImpact: impact as "low" | "medium" | "high" | "critical",
      estimatedRisk: risk as "low" | "medium" | "high",
      estimatedEffort: String(row.estimatedEffort ?? "Unknown").slice(0, 100),
      suggestedValidation: validation.slice(0, 10).map((x) => x.slice(0, 300)),
      acceptanceCriteria: acceptance.slice(0, 20).map((x) => x.slice(0, 300)),
    };
  });
}

function parseRepositoryHealthObservations(body: Buffer): RepositoryObservation[] {
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    throw new ValidationFailedError("Repository health artifact must be valid JSON");
  }
  if (!Array.isArray(value)) throw new ValidationFailedError("Repository health artifact must contain an array");
  return value.slice(0, 70).map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new ValidationFailedError("Repository health observation is invalid");
    const row = item as Record<string, unknown>;
    const dimension = String(row.dimension ?? "");
    const status = String(row.status ?? "");
    const severity = String(row.severity ?? "low");
    if (
      !(
        ["architecture", "tests", "security", "technical_debt", "documentation", "dependencies", "ci"] as string[]
      ).includes(dimension)
    )
      throw new ValidationFailedError("Repository health dimension is invalid");
    if (!(["strength", "risk", "unknown"] as string[]).includes(status))
      throw new ValidationFailedError("Repository health status is invalid");
    if (!(["low", "medium", "high", "critical"] as string[]).includes(severity))
      throw new ValidationFailedError("Repository health severity is invalid");
    const evidence = Array.isArray(row.evidence)
      ? row.evidence.slice(0, 20).map((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry))
            throw new ValidationFailedError("Repository health evidence is invalid");
          const e = entry as Record<string, unknown>;
          const path = String(e.path ?? "").trim();
          if (!path || path.startsWith("/") || path.split("/").includes(".."))
            throw new ValidationFailedError("Repository health evidence path is unsafe");
          return {
            path,
            ...(Number.isInteger(e.line) && Number(e.line) > 0 ? { line: Number(e.line) } : {}),
            ...(e.description ? { description: String(e.description).slice(0, 500) } : {}),
          };
        })
      : [];
    return {
      dimension: dimension as RepositoryObservation["dimension"],
      status: status as RepositoryObservation["status"],
      severity: severity as RepositoryObservation["severity"],
      summary: String(row.summary ?? "").slice(0, 500),
      evidence,
    };
  });
}

export async function reserveProtocolMessage(input: {
  credential: Credential;
  message: ProtocolEnvelope;
  nonce: string;
  checksum: string;
}) {
  const processingReceipt = processingProtocolReceipt(input.message.messageId);
  try {
    await getDatabasePool().query(
      `INSERT INTO agent_protocol_receipts(workspace_id,agent_id,message_id,nonce,body_checksum,acknowledgement,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '10 minutes')`,
      [
        input.credential.workspace_id,
        input.credential.agent_id,
        input.message.messageId,
        input.nonce,
        input.checksum,
        JSON.stringify(processingReceipt),
      ],
    );
    return { duplicate: false };
  } catch (error) {
    if ((error as { code?: string }).code !== "23505") throw error;
    const prior = (
      await getDatabasePool().query<{ body_checksum: string; nonce: string; acknowledgement: Record<string, unknown> }>(
        "SELECT body_checksum,nonce,acknowledgement FROM agent_protocol_receipts WHERE workspace_id=$1 AND agent_id=$2 AND (message_id=$3 OR nonce=$4)",
        [input.credential.workspace_id, input.credential.agent_id, input.message.messageId, input.nonce],
      )
    ).rows[0];
    if (!prior || prior.body_checksum !== input.checksum || prior.nonce !== input.nonce)
      throw new ValidationFailedError("Protocol replay or changed-payload reuse was rejected");
    assertDurableProtocolReceipt(prior.acknowledgement);
    if (prior.acknowledgement?.status === "processing") {
      await getDatabasePool().query(
        `DELETE FROM agent_protocol_receipts WHERE workspace_id=$1 AND agent_id=$2 AND message_id=$3
         AND acknowledgement=$4`,
        [
          input.credential.workspace_id,
          input.credential.agent_id,
          input.message.messageId,
          JSON.stringify(processingReceipt),
        ],
      );
      return reserveProtocolMessage(input);
    }
    return { duplicate: true, acknowledgement: prior.acknowledgement };
  }
}
export async function acquireProtocolMessageFence(
  credential: Credential,
  messageId: string,
): Promise<() => Promise<void>> {
  const client = await getDatabasePool().connect();
  const key = `${credential.workspace_id}:${credential.agent_id}:${messageId}`;
  await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [key]);
  return async () => {
    await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]).catch(() => undefined);
    client.release();
  };
}
export async function completeProtocolMessage(
  credential: Credential,
  messageId: string,
  acknowledgement: Record<string, unknown>,
  options: { leaseKind?: LeaseAuthorizationKind } = {},
) {
  const receipt = durableProtocolReceipt(
    {
      ...acknowledgement,
      protocolVersion: acknowledgement.protocolVersion ?? "1.0",
      messageId,
    },
    credential,
    options.leaseKind,
  );
  await getDatabasePool().query(
    "UPDATE agent_protocol_receipts SET acknowledgement=$4 WHERE workspace_id=$1 AND agent_id=$2 AND message_id=$3",
    [credential.workspace_id, credential.agent_id, messageId, JSON.stringify(receipt)],
  );
}
export async function releaseProtocolMessage(credential: Credential, messageId: string) {
  await getDatabasePool().query(
    `DELETE FROM agent_protocol_receipts WHERE workspace_id=$1 AND agent_id=$2 AND message_id=$3
     AND acknowledgement->>'status'='processing'`,
    [credential.workspace_id, credential.agent_id, messageId],
  );
}
