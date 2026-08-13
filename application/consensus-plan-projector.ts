import type { PoolClient } from "pg";
import type { DomainEvent } from "@/lib/postgres-event-store";
export async function applyConsensusPlanProjection(client: PoolClient, events: DomainEvent[]) {
  for (const event of events) {
    if (event.eventType === "consensus.created") {
      await client.query(
        `INSERT INTO consensus_plan_projections(
          workspace_id,mission_id,aggregate_version,status,consensus_attempt,repository_id,base_branch,
          repository_snapshot,repository_base_commit,repository_authority_hash,planning_schema_version,synthesizer_assignment_id,preferred_executor_agent_id,
          preferred_executor_model_id,execution_budget,require_implementation_review,maximum_rounds,maximum_turns,maximum_duration_seconds,maximum_cost_amount,
          cost_currency,maximum_artifact_bytes,maximum_command_count,maximum_retry_count,started_at,deadline_at,
          created_at,updated_at,last_event_position
        ) VALUES($1,$2,$3,'draft',1,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1,$15,$16,$17,$18,$19,$20,$21,$22,$23,$22,$22,$24)`,
        [
          event.workspaceId,
          event.aggregateId,
          event.aggregateVersion,
          event.payload.repositoryId,
          event.payload.baseBranch,
          event.payload.repositorySnapshot,
          event.payload.repositoryBaseCommit,
          event.payload.repositoryAuthorityHash,
          event.payload.planningSchemaVersion,
          event.payload.synthesizerAssignmentId,
          event.payload.preferredExecutorAgentId ?? null,
          event.payload.preferredExecutorModelId ?? null,
          JSON.stringify(event.payload.executionBudget),
          event.payload.requireImplementationReview,
          event.payload.maximumTurns,
          event.payload.maximumDurationSeconds,
          event.payload.maximumCostAmount ?? null,
          event.payload.costCurrency,
          event.payload.maximumArtifactBytes,
          event.payload.maximumCommandCount,
          event.payload.maximumRetryCount,
          event.occurredAt,
          event.payload.deadlineAt,
          event.position,
        ],
      );
      for (const participant of event.payload.participants as Array<Record<string, unknown>>) {
        await client.query(
          `INSERT INTO consensus_participant_assignments(
             workspace_id,participant_assignment_id,mission_id,role,agent_id,provider_id,model_id,
             capability_attestation_id,capability_attestation_hash,required_operations,permission_profile_hash,
             runtime_model_identity,provider_runtime_requirements_id,provider_runtime_requirements_hash,
             assigned_at,assignment_version,created_at,updated_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$15,$15)`,
          [
            event.workspaceId,
            participant.assignmentId,
            event.aggregateId,
            participant.role,
            participant.agentId,
            participant.providerId,
            participant.modelId,
            participant.capabilityAttestationId,
            participant.capabilityAttestationHash,
            JSON.stringify(participant.requiredOperations),
            participant.permissionProfileHash,
            participant.runtimeModelIdentity,
            participant.providerRuntimeRequirementsId,
            participant.providerRuntimeRequirementsHash,
            event.occurredAt,
            participant.assignmentVersion,
          ],
        );
      }
      continue;
    }
    if (event.eventType === "consensus.status_changed") {
      await client.query(
        `UPDATE consensus_plan_projections SET status=$3,aggregate_version=$4,updated_at=$5,last_event_position=$6,
         failure_reason=COALESCE($7,failure_reason),consensus_decision=COALESCE($8,consensus_decision)
         WHERE workspace_id=$1 AND mission_id=$2`,
        [
          event.workspaceId,
          event.aggregateId,
          event.payload.status,
          event.aggregateVersion,
          event.occurredAt,
          event.position,
          event.payload.reason ?? null,
          event.payload.consensusDecision ?? null,
        ],
      );
      continue;
    }
    if (event.eventType === "consensus.turn_requested") {
      await client.query(
        `INSERT INTO consensus_turns(
           workspace_id,turn_id,mission_id,participant_assignment_id,operation,round,task_id,execution_id,
           source_artifact_ids,status,created_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'requested',$10)
         ON CONFLICT(workspace_id,mission_id,participant_assignment_id,operation,round) DO NOTHING`,
        [
          event.workspaceId,
          event.payload.turnId,
          event.aggregateId,
          event.payload.participantAssignmentId,
          event.payload.operation,
          event.payload.round,
          event.payload.taskId,
          event.payload.executionId,
          JSON.stringify(event.payload.sourceArtifactIds ?? []),
          event.occurredAt,
        ],
      );
      await client.query(
        "UPDATE consensus_plan_projections SET aggregate_version=$3,updated_at=$4,last_event_position=$5 WHERE workspace_id=$1 AND mission_id=$2",
        [event.workspaceId, event.aggregateId, event.aggregateVersion, event.occurredAt, event.position],
      );
      continue;
    }
    if (event.eventType === "consensus.turn_completed") {
      await client.query(
        `UPDATE consensus_turns SET status='completed',completed_at=$4 WHERE workspace_id=$1 AND mission_id=$2 AND task_id=$3`,
        [event.workspaceId, event.aggregateId, event.payload.taskId, event.occurredAt],
      );
      await client.query(
        "UPDATE consensus_plan_projections SET aggregate_version=$3,updated_at=$4,last_event_position=$5 WHERE workspace_id=$1 AND mission_id=$2",
        [event.workspaceId, event.aggregateId, event.aggregateVersion, event.occurredAt, event.position],
      );
      continue;
    }
    if (event.eventType === "consensus.turn_failed") {
      await client.query(
        `UPDATE consensus_turns SET status='failed',completed_at=$4
         WHERE workspace_id=$1 AND mission_id=$2 AND task_id=$3`,
        [event.workspaceId, event.aggregateId, event.payload.taskId, event.occurredAt],
      );
      await client.query(
        `UPDATE consensus_plan_projections SET aggregate_version=$3,updated_at=$4,last_event_position=$5,
         failure_reason=$6 WHERE workspace_id=$1 AND mission_id=$2`,
        [
          event.workspaceId,
          event.aggregateId,
          event.aggregateVersion,
          event.occurredAt,
          event.position,
          event.payload.reason,
        ],
      );
      continue;
    }
    if (event.eventType === "consensus.artifact_recorded") {
      const normalizedPayload = (event.payload.normalizedPayload as Record<string, unknown> | undefined) ?? null;
      const blockingObjections = Array.isArray(event.payload.blockingObjections)
        ? event.payload.blockingObjections
        : [];
      await client.query(
        `INSERT INTO consensus_artifacts(
          workspace_id,artifact_id,mission_id,participant_assignment_id,turn_id,artifact_kind,schema_version,round,
          repository_snapshot,context_pack_hash,reviewed_artifact_id,revises_proposal_artifact_id,
          prior_revision_artifact_id,canonical_plan_hash,verdict,
          blocking_objection_count,artifact_checksum,normalized_payload,immutable,created_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,true,$19)
        ON CONFLICT(workspace_id,artifact_id) DO NOTHING`,
        [
          event.workspaceId,
          event.payload.artifactId,
          event.aggregateId,
          event.payload.participantAssignmentId ?? null,
          event.payload.turnId ?? null,
          event.payload.artifactKind,
          event.payload.schemaVersion,
          event.payload.round ?? 1,
          event.payload.repositorySnapshot,
          event.payload.contextPackHash ?? null,
          event.payload.reviewedArtifactId ?? null,
          event.payload.revisesProposalArtifactId ?? null,
          event.payload.priorRevisionArtifactId ?? null,
          event.payload.canonicalPlanHash ?? null,
          event.payload.verdict ?? null,
          event.payload.blockingObjectionCount ?? 0,
          event.payload.artifactChecksum,
          normalizedPayload ? JSON.stringify(normalizedPayload) : null,
          event.occurredAt,
        ],
      );
      if (normalizedPayload)
        for (const blocker of blockingObjections)
          await client.query(
            `INSERT INTO consensus_objections(
               workspace_id,mission_id,objection_id,raw_provider_objection_id,consensus_attempt,source_artifact_id,
               participant_assignment_id,round,category,description,required_change,created_at
             ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [
              event.workspaceId,
              event.aggregateId,
              blocker.objectionId,
              blocker.rawProviderObjectionId,
              event.payload.consensusAttempt,
              event.payload.artifactId,
              event.payload.participantAssignmentId,
              event.payload.round,
              blocker.category,
              blocker.description,
              blocker.requiredChange,
              event.occurredAt,
            ],
          );
      if (event.payload.artifactKind === "project_brain_context_pack")
        await client.query(
          `UPDATE consensus_plan_projections SET project_brain_context_artifact_id=$3,context_pack_hash=$4,
           aggregate_version=$5,updated_at=$6,last_event_position=$7 WHERE workspace_id=$1 AND mission_id=$2`,
          [
            event.workspaceId,
            event.aggregateId,
            event.payload.artifactId,
            event.payload.contextPackHash,
            event.aggregateVersion,
            event.occurredAt,
            event.position,
          ],
        );
      else if (event.payload.artifactKind === "canonical_implementation_plan")
        await client.query(
          `UPDATE consensus_plan_projections SET canonical_plan_artifact_id=$3,canonical_plan_hash=$4,
           canonical_plan_schema_version=$5,aggregate_version=$6,updated_at=$7,last_event_position=$8
           WHERE workspace_id=$1 AND mission_id=$2`,
          [
            event.workspaceId,
            event.aggregateId,
            event.payload.artifactId,
            event.payload.canonicalPlanHash,
            event.payload.schemaVersion,
            event.aggregateVersion,
            event.occurredAt,
            event.position,
          ],
        );
      else
        await client.query(
          "UPDATE consensus_plan_projections SET aggregate_version=$3,updated_at=$4,last_event_position=$5 WHERE workspace_id=$1 AND mission_id=$2",
          [event.workspaceId, event.aggregateId, event.aggregateVersion, event.occurredAt, event.position],
        );
      continue;
    }
    if (event.eventType === "consensus.objections_resolved") {
      await client.query(
        `UPDATE consensus_objections SET status='resolved',resolved_by_artifact_id=$4,resolved_at=$5
         WHERE workspace_id=$1 AND mission_id=$2 AND objection_id=ANY($3::uuid[]) AND source_artifact_id=$6
           AND status='open'`,
        [
          event.workspaceId,
          event.aggregateId,
          event.payload.objectionIds,
          event.payload.resolvedByArtifactId,
          event.occurredAt,
          event.payload.sourceCritiqueArtifactId,
        ],
      );
      await client.query(
        `UPDATE consensus_plan_projections SET aggregate_version=$3,updated_at=$4,last_event_position=$5
         WHERE workspace_id=$1 AND mission_id=$2`,
        [event.workspaceId, event.aggregateId, event.aggregateVersion, event.occurredAt, event.position],
      );
      continue;
    }
    if (event.eventType === "consensus.approval_requested") {
      await client.query(
        `UPDATE consensus_plan_projections SET human_approval_id=$3,aggregate_version=$4,updated_at=$5,last_event_position=$6
         WHERE workspace_id=$1 AND mission_id=$2`,
        [
          event.workspaceId,
          event.aggregateId,
          event.payload.approvalId,
          event.aggregateVersion,
          event.occurredAt,
          event.position,
        ],
      );
      continue;
    }
    if (event.eventType === "consensus.stale_detected") {
      await client.query(
        `UPDATE consensus_plan_projections SET stale_at=$3,failure_reason=$4,aggregate_version=$5,updated_at=$3,last_event_position=$6
         WHERE workspace_id=$1 AND mission_id=$2`,
        [
          event.workspaceId,
          event.aggregateId,
          event.occurredAt,
          event.payload.reason,
          event.aggregateVersion,
          event.position,
        ],
      );
      continue;
    }
    if (event.eventType === "consensus.implementation_mission_created")
      await client.query(
        `UPDATE consensus_plan_projections SET implementation_mission_id=$3,aggregate_version=$4,updated_at=$5,last_event_position=$6
         WHERE workspace_id=$1 AND mission_id=$2`,
        [
          event.workspaceId,
          event.aggregateId,
          event.payload.implementationMissionId,
          event.aggregateVersion,
          event.occurredAt,
          event.position,
        ],
      );
    if (event.eventType === "consensus.learning_candidate_proposed")
      await client.query(
        `UPDATE consensus_plan_projections SET learning_candidate_artifact_id=$3,learning_candidate_status='proposed',
         aggregate_version=$4,updated_at=$5,last_event_position=$6 WHERE workspace_id=$1 AND mission_id=$2`,
        [
          event.workspaceId,
          event.aggregateId,
          event.payload.artifactId,
          event.aggregateVersion,
          event.occurredAt,
          event.position,
        ],
      );
  }
}
