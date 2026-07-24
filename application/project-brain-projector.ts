import type { PoolClient } from "pg";
import type { DomainEvent } from "@/lib/postgres-event-store";

const successfulFactNames = [
  "project_brain.context_generated",
  "project_brain.closure_recorded",
  "project_brain.learning_proposed",
  "project_brain.learning_evaluated",
];
const successfulFacts = new Set(successfulFactNames);
const terminal = new Set([
  "project_brain.operation_succeeded",
  "project_brain.operation_failed",
  "project_brain.remote_operation_denied",
  "project_brain.remote_operation_failed",
  ...successfulFactNames,
]);

export async function applyProjectBrainProjection(client: PoolClient, events: DomainEvent[]) {
  for (const event of events) {
    const p = event.payload;
    const repositoryProjection = (p.repositoryProjection ?? {}) as Record<string, unknown>;
    const missionProjection = (p.missionProjection ?? {}) as Record<string, unknown>;
    const status =
      event.eventType === "project_brain.operation_authorized"
        ? "authorized"
        : event.eventType === "project_brain.operation_denied" ||
            event.eventType === "project_brain.remote_operation_denied"
          ? "denied"
          : event.eventType === "project_brain.remote_operation_dispatched"
            ? "dispatched"
            : event.eventType === "project_brain.remote_operation_accepted"
              ? "accepted"
              : event.eventType === "project_brain.operation_started" ||
                  event.eventType === "project_brain.remote_operation_started"
                ? "started"
                : event.eventType === "project_brain.operation_succeeded" || successfulFacts.has(event.eventType)
                  ? "succeeded"
                  : event.eventType === "project_brain.operation_failed" ||
                      event.eventType === "project_brain.remote_operation_failed"
                    ? "failed"
                    : null;
    if (event.eventType === "project_brain.operation_requested") {
      await client.query(
        `INSERT INTO project_brain_operation_projections(
          workspace_id,operation_id,aggregate_version,last_event_position,repository_id,mission_id,execution_id,
          agent_id,operation,location_mode,status,request,request_fingerprint,starting_sha,
          required_project_brain_version,required_contract_version,approval_id,policy_decision,
          created_at,updated_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'requested',$11,$12,$13,$14,$15,$16,$17,$18,$18)
        ON CONFLICT(workspace_id,operation_id) DO UPDATE SET
          aggregate_version=EXCLUDED.aggregate_version,last_event_position=EXCLUDED.last_event_position`,
        [
          event.workspaceId,
          event.aggregateId,
          event.aggregateVersion,
          event.position,
          p.repositoryId,
          event.missionId,
          p.executionId ?? null,
          p.agentId ?? null,
          p.operation,
          p.locationMode,
          JSON.stringify(p.request ?? {}),
          p.requestFingerprint,
          p.startingSha ?? null,
          p.requiredProjectBrainVersion,
          p.requiredContractVersion,
          p.approvalId ?? null,
          JSON.stringify(p.policyDecision ?? {}),
          event.occurredAt,
        ],
      );
    } else {
      await client.query(
        `UPDATE project_brain_operation_projections SET
          aggregate_version=$3,last_event_position=$4,status=COALESCE($5,status),
          worker_id=COALESCE($6,worker_id),ending_sha=COALESCE($7,ending_sha),
          result=COALESCE($8,result),failure_stage=COALESCE($9,failure_stage),
          failure_cause=COALESCE($10,failure_cause),
          started_at=CASE WHEN $11 THEN $12 ELSE started_at END,
          completed_at=CASE WHEN $13 THEN $12 ELSE completed_at END,updated_at=$12
        WHERE workspace_id=$1 AND operation_id=$2`,
        [
          event.workspaceId,
          event.aggregateId,
          event.aggregateVersion,
          event.position,
          status,
          p.workerId ?? null,
          p.endingSha ?? null,
          p.result ? JSON.stringify(p.result) : null,
          p.failureStage ?? null,
          p.failureCause ?? null,
          event.eventType === "project_brain.operation_started" ||
            event.eventType === "project_brain.remote_operation_started",
          event.occurredAt,
          terminal.has(event.eventType) || event.eventType === "project_brain.operation_denied",
        ],
      );
    }

    if (p.repositoryId)
      await client.query(
        `INSERT INTO repository_project_brain_projections(
          workspace_id,repository_id,last_operation,last_operation_status,last_refreshed_at,last_event_position,
          availability_state,compatibility_state,last_validation_status,last_validated_sha,project_brain_version,
          contract_version,schema_versions,current_state_freshness,proposed_learning_count,confirmed_learning_count,
          stale_count,unresolved_contradiction_count,diagnostic_warning_summary
        ) VALUES($1,$2,$3,$4,$5,$6,COALESCE($7,'unknown'),COALESCE($8,'unknown'),$9,$10,$11,$12,
          COALESCE($13,'[]'::jsonb),COALESCE($14,'unknown'),COALESCE($15,0),COALESCE($16,0),
          COALESCE($17,0),COALESCE($18,0),COALESCE($19,'[]'::jsonb))
        ON CONFLICT(workspace_id,repository_id) DO UPDATE SET
          last_operation=EXCLUDED.last_operation,last_operation_status=EXCLUDED.last_operation_status,
          last_refreshed_at=EXCLUDED.last_refreshed_at,last_event_position=EXCLUDED.last_event_position,
          availability_state=COALESCE($7,repository_project_brain_projections.availability_state),
          compatibility_state=COALESCE($8,repository_project_brain_projections.compatibility_state),
          last_validation_status=COALESCE($9,repository_project_brain_projections.last_validation_status),
          last_validated_sha=COALESCE($10,repository_project_brain_projections.last_validated_sha),
          project_brain_version=COALESCE($11,repository_project_brain_projections.project_brain_version),
          contract_version=COALESCE($12,repository_project_brain_projections.contract_version),
          schema_versions=COALESCE($13,repository_project_brain_projections.schema_versions),
          current_state_freshness=COALESCE($14,repository_project_brain_projections.current_state_freshness),
          proposed_learning_count=COALESCE($15,repository_project_brain_projections.proposed_learning_count),
          confirmed_learning_count=COALESCE($16,repository_project_brain_projections.confirmed_learning_count),
          stale_count=COALESCE($17,repository_project_brain_projections.stale_count),
          unresolved_contradiction_count=COALESCE($18,repository_project_brain_projections.unresolved_contradiction_count),
          diagnostic_warning_summary=COALESCE($19,repository_project_brain_projections.diagnostic_warning_summary)`,
        [
          event.workspaceId,
          p.repositoryId,
          p.operation,
          p.operationStatus ?? status ?? "running",
          event.occurredAt,
          event.position,
          repositoryProjection.availabilityState ?? null,
          repositoryProjection.compatibilityState ?? null,
          repositoryProjection.lastValidationStatus ?? null,
          repositoryProjection.lastValidatedSha ?? null,
          repositoryProjection.projectBrainVersion ?? null,
          repositoryProjection.contractVersion ?? null,
          repositoryProjection.schemaVersions ? JSON.stringify(repositoryProjection.schemaVersions) : null,
          repositoryProjection.currentStateFreshness ?? null,
          repositoryProjection.proposedLearningCount ?? null,
          repositoryProjection.confirmedLearningCount ?? null,
          repositoryProjection.staleCount ?? null,
          repositoryProjection.unresolvedContradictionCount ?? null,
          p.warnings ? JSON.stringify(p.warnings) : null,
        ],
      );

    if (event.missionId && p.missionProjection)
      await client.query(
        `INSERT INTO mission_project_brain_projections(
          workspace_id,mission_id,last_event_position,context_preview_status,final_context_artifact_id,
          context_repository_path,context_checksum,context_schema_version,contract_version,starting_sha,
          selected_source_manifest,context_bytes,context_quality,context_bound_status,bound_execution_id,
          assigned_agent_id,agent_received_checksum,agent_verified_checksum,agent_verification_status,
          bound_at,verified_at,closure_status,learning_proposal_status,evaluation_status
        ) VALUES($1,$2,$3,COALESCE($4,'not_requested'),$5,$6,$7,$8,$9,$10,COALESCE($11,'[]'::jsonb),$12,
          COALESCE($13,'{}'::jsonb),COALESCE($14,'unbound'),$15,$16,$17,$18,
          COALESCE($19,'not_reported'),$20,$21,COALESCE($22,'not_recorded'),
          COALESCE($23,'not_proposed'),COALESCE($24,'not_evaluated'))
        ON CONFLICT(workspace_id,mission_id) DO UPDATE SET
          last_event_position=EXCLUDED.last_event_position,
          context_preview_status=COALESCE($4,mission_project_brain_projections.context_preview_status),
          final_context_artifact_id=COALESCE($5,mission_project_brain_projections.final_context_artifact_id),
          context_repository_path=COALESCE($6,mission_project_brain_projections.context_repository_path),
          context_checksum=COALESCE($7,mission_project_brain_projections.context_checksum),
          context_schema_version=COALESCE($8,mission_project_brain_projections.context_schema_version),
          contract_version=COALESCE($9,mission_project_brain_projections.contract_version),
          starting_sha=COALESCE($10,mission_project_brain_projections.starting_sha),
          selected_source_manifest=COALESCE($11,mission_project_brain_projections.selected_source_manifest),
          context_bytes=COALESCE($12,mission_project_brain_projections.context_bytes),
          context_quality=COALESCE($13,mission_project_brain_projections.context_quality),
          context_bound_status=COALESCE($14,mission_project_brain_projections.context_bound_status),
          bound_execution_id=COALESCE($15,mission_project_brain_projections.bound_execution_id),
          assigned_agent_id=COALESCE($16,mission_project_brain_projections.assigned_agent_id),
          agent_received_checksum=COALESCE($17,mission_project_brain_projections.agent_received_checksum),
          agent_verified_checksum=COALESCE($18,mission_project_brain_projections.agent_verified_checksum),
          agent_verification_status=COALESCE($19,mission_project_brain_projections.agent_verification_status),
          bound_at=COALESCE($20,mission_project_brain_projections.bound_at),
          verified_at=COALESCE($21,mission_project_brain_projections.verified_at),
          closure_status=COALESCE($22,mission_project_brain_projections.closure_status),
          learning_proposal_status=COALESCE($23,mission_project_brain_projections.learning_proposal_status),
          evaluation_status=COALESCE($24,mission_project_brain_projections.evaluation_status)`,
        [
          event.workspaceId,
          event.missionId,
          event.position,
          missionProjection.contextPreviewStatus ?? null,
          missionProjection.finalContextArtifactId ?? null,
          missionProjection.contextRepositoryPath ?? null,
          missionProjection.contextChecksum ?? null,
          missionProjection.contextSchemaVersion ?? null,
          missionProjection.contractVersion ?? null,
          missionProjection.startingSha ?? null,
          missionProjection.selectedSourceManifest ? JSON.stringify(missionProjection.selectedSourceManifest) : null,
          missionProjection.contextBytes ?? null,
          missionProjection.contextQuality ? JSON.stringify(missionProjection.contextQuality) : null,
          missionProjection.contextBoundStatus ?? null,
          missionProjection.boundExecutionId ?? null,
          missionProjection.assignedAgentId ?? null,
          missionProjection.agentReceivedChecksum ?? null,
          missionProjection.agentVerifiedChecksum ?? null,
          missionProjection.agentVerificationStatus ?? null,
          missionProjection.boundAt ?? null,
          missionProjection.verifiedAt ?? null,
          missionProjection.closureStatus ?? null,
          missionProjection.learningProposalStatus ?? null,
          missionProjection.evaluationStatus ?? null,
        ],
      );
  }
}
