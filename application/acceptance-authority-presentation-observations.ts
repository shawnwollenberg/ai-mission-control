import { randomUUID } from "node:crypto";
import { getDatabasePool } from "@/lib/database";
import { canonicalHash } from "@/lib/canonical-json";
import { ValidationFailedError, type ApplicationErrorCode } from "@/lib/application-errors";
import { parseExecutionAuthorityPresentation } from "@/domain/execution-authority-presentation";
import type { ProtocolEnvelope } from "@/remote-agent/protocol";
import { runtimeTrustEvidence, type RuntimeTrustEvidence } from "@/lib/runtime-trust";

export const ACTIVE_PRESENTATION_ROUTE_IDENTITY = "agent-protocol.messages.POST/active-execution-fence/1";
export function authorityPresentationAcceptanceTrustEnabled(input: {
  appEnvironment: string | undefined;
  providerRuntimeMode: string | undefined;
  trust: RuntimeTrustEvidence;
}) {
  if (input.appEnvironment !== "disposable_acceptance" || input.trust.productionResourcesAllowed) return false;
  if (input.providerRuntimeMode === "mock_provider_acceptance")
    return (
      input.trust.runtimeMode === "disposable_acceptance" &&
      input.trust.disposable === true &&
      input.trust.trustAuthority === "non_authenticated_candidate_validation" &&
      input.trust.registryScope === "non_authenticated_candidate_validation"
    );
  return (
    input.providerRuntimeMode === "consensus_real_provider_acceptance" &&
    input.trust.runtimeMode === "disposable_acceptance" &&
    input.trust.disposable === true &&
    input.trust.trustAuthority === "disposable_exact_checksum_registry" &&
    input.trust.registryVersion === "mission-agent-disposable-acceptance/2" &&
    input.trust.registryScope === "consensus_real_provider_acceptance"
  );
}

export const activePresentationAcceptanceEnabled = () => {
  if (process.env.APP_ENV === "test" && process.env.CONSENSUS_ACTIVE_PRESENTATION_FOCUSED_TEST === "true") return true;
  try {
    const trust = runtimeTrustEvidence();
    const providerRuntimeMode =
      process.env.CONSENSUS_PROVIDER_RUNTIME_MODE ??
      (trust.trustAuthority === "disposable_exact_checksum_registry" &&
      trust.registryScope === "consensus_real_provider_acceptance"
        ? "consensus_real_provider_acceptance"
        : undefined);
    return authorityPresentationAcceptanceTrustEnabled({
      appEnvironment: process.env.APP_ENV,
      providerRuntimeMode,
      trust,
    });
  } catch {
    return false;
  }
};

export async function persistActiveProviderAttempt(input: {
  message: ProtocolEnvelope;
  workspaceId: string;
  agentId: string;
}) {
  if (!activePresentationAcceptanceEnabled()) return;
  const value = input.message.payload.activeProviderAttempt as Record<string, unknown> | undefined;
  if (!value || !input.message.executionId) return;
  const authority = (
    await getDatabasePool().query(
      `SELECT p.assignment_id,p.attempt,a.provider_id,a.model_id,a.provider_runtime_requirements_id runtime_profile_id,
            a.provider_runtime_requirements_hash runtime_profile_hash
       FROM pull_assignments p JOIN consensus_participant_assignments a
         ON a.workspace_id=p.workspace_id AND a.mission_id=(p.payload#>>'{approvedPlan,parentConsensusMissionId}')::uuid
        AND a.role='executor'
      WHERE p.workspace_id=$1 AND p.execution_id=$2 AND p.agent_id=$3 AND p.status IN('leased','acknowledged')`,
      [input.workspaceId, input.message.executionId, input.agentId],
    )
  ).rows[0];
  if (
    !authority ||
    value.providerId !== authority.provider_id ||
    value.modelId !== authority.model_id ||
    value.runtimeProfileId !== authority.runtime_profile_id ||
    value.runtimeProfileHash !== authority.runtime_profile_hash ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(String(value.providerAttemptId ?? ""))
  )
    throw new ValidationFailedError("Active provider-attempt authority does not match the claimed assignment");
  const inserted = await getDatabasePool().query(
    `INSERT INTO acceptance_active_provider_attempts(workspace_id,execution_id,assignment_id,assignment_attempt,
       provider_attempt_id,agent_id,provider_id,model_id,runtime_profile_id,runtime_profile_hash,provenance_message_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      input.workspaceId,
      input.message.executionId,
      authority.assignment_id,
      authority.attempt,
      value.providerAttemptId,
      input.agentId,
      authority.provider_id,
      authority.model_id,
      authority.runtime_profile_id,
      authority.runtime_profile_hash,
      input.message.messageId,
    ],
  );
  if (inserted.rowCount !== 1) throw new ValidationFailedError("Active provider-attempt authority was not persisted");
}

export async function persistAuthorityLocalStateObservation(input: {
  message: ProtocolEnvelope;
  workspaceId: string;
  agentId: string;
}) {
  if (!activePresentationAcceptanceEnabled() || !input.message.executionId) return;
  const value = input.message.payload.acceptanceAuthorityLocalStateObservation as Record<string, unknown> | undefined;
  if (!value) return;
  const hashes = [
    value.repositoryStateBeforeSha256,
    value.repositoryStateAfterSha256,
    value.repositoryStatusBeforeSha256,
    value.repositoryStatusAfterSha256,
  ];
  if (
    !hashes.every((item) => /^[a-f0-9]{64}$/.test(String(item))) ||
    !/^[a-f0-9]{40,64}$/.test(String(value.repositoryHeadBefore ?? "")) ||
    !/^[a-f0-9]{40,64}$/.test(String(value.repositoryHeadAfter ?? ""))
  )
    throw new ValidationFailedError("Acceptance authority local repository observation is malformed");
  const inserted = await getDatabasePool().query(
    `INSERT INTO acceptance_authority_local_state_observations(
       workspace_id,execution_id,assignment_id,agent_id,requirement_id,rejection_message_id,provenance_message_id,
       repository_state_before_sha256,repository_state_after_sha256,repository_head_before,repository_head_after,
       repository_status_before_sha256,repository_status_after_sha256)
     SELECT $1,$2,o.assignment_id,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
       FROM acceptance_authority_presentation_observations o
      WHERE o.workspace_id=$1 AND o.execution_id=$2 AND o.agent_id=$3 AND o.requirement_id=$4 AND o.message_id=$5`,
    [
      input.workspaceId,
      input.message.executionId,
      input.agentId,
      String(value.requirementId),
      String(value.rejectionMessageId),
      input.message.messageId,
      ...hashes.slice(0, 2).map(String),
      String(value.repositoryHeadBefore),
      String(value.repositoryHeadAfter),
      ...hashes.slice(2).map(String),
    ],
  );
  if (inserted.rowCount !== 1)
    throw new ValidationFailedError(
      "Acceptance authority rejection observation is unavailable for local state binding",
    );
}

export async function activeProviderAttemptId(workspaceId: string, executionId: string, assignmentId: string) {
  return (
    await getDatabasePool().query<{ provider_attempt_id: string }>(
      `SELECT provider_attempt_id FROM acceptance_active_provider_attempts
      WHERE workspace_id=$1 AND execution_id=$2 AND assignment_id=$3 ORDER BY recorded_at DESC LIMIT 1`,
      [workspaceId, executionId, assignmentId],
    )
  ).rows[0]?.provider_attempt_id;
}

const applicationErrorCodes = new Set<ApplicationErrorCode>([
  "unauthenticated",
  "forbidden",
  "not_found",
  "validation_failed",
  "concurrency_conflict",
  "invalid_transition",
  "duplicate_command",
  "dependency_conflict",
  "database_unavailable",
]);

export function governedApplicationError(error: unknown) {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { code?: unknown; message?: unknown; details?: unknown };
  if (
    typeof candidate.code !== "string" ||
    !applicationErrorCodes.has(candidate.code as ApplicationErrorCode) ||
    typeof candidate.message !== "string" ||
    (candidate.details !== undefined &&
      (!candidate.details || typeof candidate.details !== "object" || Array.isArray(candidate.details)))
  )
    return undefined;
  return {
    code: candidate.code as ApplicationErrorCode,
    message: candidate.message,
    details: candidate.details as Record<string, unknown> | undefined,
  };
}

export async function captureActivePresentationState(workspaceId: string, assignmentId: string) {
  const database = getDatabasePool();
  const authority = (
    await database.query(
      `SELECT assignment_id,status,lease_receipt_id,lease_token_fingerprint,lease_owner,lease_expires_at,
            fencing_token::text,attempt
       FROM pull_assignments WHERE workspace_id=$1 AND assignment_id=$2`,
      [workspaceId, assignmentId],
    )
  ).rows[0];
  const counts = (
    await database.query(
      `SELECT
       (SELECT coalesce(jsonb_agg(jsonb_build_array(event_id,event_type,aggregate_type,aggregate_id,aggregate_version)
          ORDER BY position),'[]'::jsonb) FROM events WHERE workspace_id=$1 AND mission_id=p.mission_id) event_identities,
       (SELECT jsonb_build_object('missionId',mission_id,'status',status,'aggregateVersion',aggregate_version,
          'repositoryId',repository_id,'baseCommit',base_commit,'repositoryAuthorityHash',repository_authority_hash)
          FROM mission_projections WHERE workspace_id=$1 AND mission_id=p.mission_id) child_mission_state,
       (SELECT jsonb_build_object('taskId',task_id,'status',status,'aggregateVersion',aggregate_version)
          FROM task_projections WHERE workspace_id=$1 AND task_id=p.task_id) implementation_task_state,
       (SELECT jsonb_build_object('executionId',execution_id,'status',status,'aggregateVersion',aggregate_version,
          'attempt',attempt,'outputSummary',output_summary,'error',error)
          FROM execution_projections WHERE workspace_id=$1 AND execution_id=p.execution_id) implementation_result_state,
       (SELECT coalesce(jsonb_agg(jsonb_build_array(validation_receipt_id,receipt_hash,provenance_message_id)
          ORDER BY created_at),'[]'::jsonb) FROM consensus_execution_validation_receipts
          WHERE workspace_id=$1 AND execution_id=p.execution_id) validation_receipt_identities,
       (SELECT coalesce(jsonb_agg(jsonb_build_array(artifact_id,checksum_sha256,kind) ORDER BY created_at),'[]'::jsonb)
          FROM artifacts WHERE workspace_id=$1 AND execution_id=p.execution_id AND deleted_at IS NULL) artifact_identities,
       (SELECT jsonb_build_object('repositoryId',repository_id,'fingerprint',repository_fingerprint,
          'observedCommit',observed_commit,'authorityHash',repository_authority_hash,
          'writeAllowed',write_allowed,'commitAllowed',commit_allowed,'localCommitAllowed',mission_agent_local_commit_allowed,
          'providerDirectCommitAllowed',provider_direct_commit_allowed,'publicationAllowed',publication_allowed)
          FROM repositories WHERE workspace_id=$1 AND repository_id=(p.payload#>>'{approvedPlan,repositoryId}')::uuid)
          repository_state
     FROM pull_assignments p WHERE p.workspace_id=$1 AND p.assignment_id=$2`,
      [workspaceId, assignmentId],
    )
  ).rows[0];
  return { authority, counts, sha256: canonicalHash({ authority, counts }) };
}

export async function recordActivePresentationRejection(input: {
  message: ProtocolEnvelope;
  workspaceId: string;
  agentId: string;
  baselineValid: boolean;
  stateBefore: Awaited<ReturnType<typeof captureActivePresentationState>>;
  error: unknown;
}) {
  if (!activePresentationAcceptanceEnabled()) return undefined;
  const scenario = input.message.payload.acceptanceAuthorityPresentationScenario as Record<string, unknown> | undefined;
  if (!scenario || !input.message.executionId) return undefined;
  const baseline = parseExecutionAuthorityPresentation(scenario.baselinePresentation);
  const attempted = parseExecutionAuthorityPresentation(input.message.payload.executionAuthorityPresentation);
  const stateAfter = await captureActivePresentationState(input.workspaceId, attempted.assignmentId);
  const error = governedApplicationError(input.error);
  await getDatabasePool().query(
    `INSERT INTO acceptance_authority_presentation_observations(
       observation_id,workspace_id,agent_id,message_id,execution_id,assignment_id,requirement_id,scenario_id,
       mutation_kind,baseline_presentation,attempted_presentation,baseline_presentation_sha256,
       attempted_presentation_sha256,route_identity,assignment_status,lease_receipt_id,lease_token_fingerprint,
       lease_owner,lease_expires_at,fencing_token,baseline_valid,top_level_code,reason_code,
       durable_state_before_sha256,durable_state_after_sha256,durable_counts_before,durable_counts_after)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)`,
    [
      randomUUID(),
      input.workspaceId,
      input.agentId,
      input.message.messageId,
      input.message.executionId,
      attempted.assignmentId,
      String(scenario.requirementId),
      String(scenario.scenarioId),
      String(scenario.mutationKind),
      JSON.stringify(baseline),
      JSON.stringify(attempted),
      canonicalHash(baseline),
      canonicalHash(attempted),
      ACTIVE_PRESENTATION_ROUTE_IDENTITY,
      String(input.stateBefore.authority?.status),
      input.stateBefore.authority?.lease_receipt_id,
      input.stateBefore.authority?.lease_token_fingerprint,
      input.stateBefore.authority?.lease_owner,
      input.stateBefore.authority?.lease_expires_at,
      input.stateBefore.authority?.fencing_token,
      input.baselineValid,
      error?.code ?? "internal_error",
      String(error?.details?.reason_code ?? error?.code ?? "internal_error"),
      input.stateBefore.sha256,
      stateAfter.sha256,
      JSON.stringify(input.stateBefore.counts),
      JSON.stringify(stateAfter.counts),
    ],
  );
  return error;
}
