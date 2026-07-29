import { getDatabasePool } from "@/lib/database";
import { ValidationFailedError } from "@/lib/application-errors";
import { handleExecutionFact, handleExecutionTransition } from "@/application/execution-commands";
import { handleTaskTransition } from "@/application/task-commands";
import { appendEvents, loadAggregateEvents } from "@/lib/postgres-event-store";
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

type Credential = {
  workspace_id: string;
  agent_id: string;
  credential_id: string;
  credential_record_status: string;
};
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
    }>(
      `SELECT e.mission_id,e.task_id,e.agent_id,e.attempt,e.status,e.repository_id,a.delivery_mode,
        mp.context_checksum,mp.starting_sha,mp.agent_verification_status FROM execution_projections e
       JOIN agents a ON a.workspace_id=e.workspace_id AND a.agent_id=e.agent_id
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
const actor = (credential: Credential) => ({
  workspaceId: credential.workspace_id,
  id: credential.agent_id,
  type: "agent" as const,
});
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
    const events = await loadAggregateEvents({
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
      expectedVersion: events.length,
      commandId: stableUuid(`remote:${message.messageId}`),
      commandType: message.messageType,
      correlationId: message.correlationId,
      causationId: events.at(-1)?.eventId,
      actor: { type: "agent", id: credential.agent_id },
      events: [
        { eventType, eventSchemaVersion: 1, occurredAt: message.sentAt, payload: message.payload },
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
                },
              },
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
          await client.query(
            `UPDATE agents SET last_heartbeat_at=$3,status=CASE WHEN status='disabled' THEN status ELSE 'active' END,
             pull_ready_at=CASE WHEN $4 THEN $3 ELSE pull_ready_at END,
             mission_agent_version=CASE WHEN $4 THEN $5 ELSE mission_agent_version END,
             mission_agent_adapter=CASE WHEN $4 THEN $6 ELSE mission_agent_adapter END,updated_at=$3
             WHERE workspace_id=$1 AND agent_id=$2`,
            [
              credential.workspace_id,
              credential.agent_id,
              last.occurredAt,
              pullReady,
              pullReady ? String(message.payload.missionAgentVersion ?? "unknown") : null,
              pullReady ? String(message.payload.adapter ?? "generic") : null,
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
  if (["succeeded", "failed", "timed_out", "cancelled"].includes(current.status))
    return { status: "ignored_terminal", executionStatus: current.status };
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
      const parsedRecommendations =
        artifactKind === "repository_recommendations" ? parseRepositoryRecommendations(body) : undefined;
      const parsedHealth =
        artifactKind === "repository_health_observations" ? parseRepositoryHealthObservations(body) : undefined;
      const artifact = await storeExecutionArtifact({
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
        },
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
      const approval = (
        await getDatabasePool().query<{ approval_id: string; status: string; action_hash: string }>(
          `SELECT approval_id,status,action_hash FROM approval_projections
           WHERE workspace_id=$1 AND execution_id=$2 AND agent_id=$3 AND approval_type='remote_workflow'
           ORDER BY created_at DESC LIMIT 1`,
          [credential.workspace_id, message.executionId, credential.agent_id],
        )
      ).rows[0];
      if (
        !approval ||
        approval.status !== "granted" ||
        String(message.payload.approvalId ?? "") !== approval.approval_id ||
        String(message.payload.actionHash ?? "") !== approval.action_hash
      )
        throw new ValidationFailedError("Execution cannot resume without the exact granted approval");
      await transition(message, credential, "running");
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
      await transition(message, credential, "succeeded", "succeeded");
      const usage = message.payload.usage;
      if (usage && typeof usage === "object" && !Array.isArray(usage)) {
        const report = usage as Record<string, unknown>;
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
              provider: "remote_agent",
              runtime: String(report.runtime ?? "remote_http"),
              model: report.model ? String(report.model) : undefined,
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
            provider: "remote_agent",
            runtime: String(report.runtime ?? "remote_http"),
            model: report.model ? String(report.model) : undefined,
            metricType: "cost",
            quantity: cost,
            unit: String(report.currency ?? "USD"),
            costAmount: cost,
            currency: String(report.currency ?? "USD"),
            costConfidence: "provider_reported",
            source: "authenticated_remote_agent",
          });
      }
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
      await transition(message, credential, "cancelled");
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
  try {
    await getDatabasePool().query(
      `INSERT INTO agent_protocol_receipts(workspace_id,agent_id,message_id,nonce,body_checksum,acknowledgement,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '10 minutes')`,
      [
        input.credential.workspace_id,
        input.credential.agent_id,
        input.message.messageId,
        input.nonce,
        input.checksum,
        JSON.stringify({ status: "processing" }),
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
    return { duplicate: true, acknowledgement: prior.acknowledgement };
  }
}
export async function completeProtocolMessage(
  credential: Credential,
  messageId: string,
  acknowledgement: Record<string, unknown>,
) {
  await getDatabasePool().query(
    "UPDATE agent_protocol_receipts SET acknowledgement=$4 WHERE workspace_id=$1 AND agent_id=$2 AND message_id=$3",
    [credential.workspace_id, credential.agent_id, messageId, JSON.stringify(acknowledgement)],
  );
}
export async function releaseProtocolMessage(credential: Credential, messageId: string) {
  await getDatabasePool().query(
    "DELETE FROM agent_protocol_receipts WHERE workspace_id=$1 AND agent_id=$2 AND message_id=$3 AND acknowledgement=$4",
    [credential.workspace_id, credential.agent_id, messageId, JSON.stringify({ status: "processing" })],
  );
}
