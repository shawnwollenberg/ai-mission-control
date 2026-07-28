import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { handleRequestRemoteExecution } from "./execution-commands";
import { handleCreateMission, handleMissionTransition } from "./mission-commands";
import { handleCreateTask, handleTaskTransition } from "./task-commands";
import { getDatabasePool } from "../lib/database";
import { stableUuid } from "../lib/stable-id";
import { NAMED_CANARY_ID } from "../integrations/mission-agent/replacement-bootstrap";
import { canonicalJson } from "../integrations/mission-agent/release-authority";
import { rehydrateMission } from "../domain/mission";
import { rehydrateExecution } from "../domain/execution";
import { loadAggregateEvents } from "../lib/postgres-event-store";
import { readExecutionArtifact } from "../execution/artifact-store";

export const REPLACEMENT_SMOKE_TEMPLATE_PATH =
  "release/mission-agent-0.7.2/replacement-bootstrap/read-only-smoke-template.json" as const;
export const REPLACEMENT_SMOKE_TEMPLATE_CHECKSUM =
  "9a2c0df075b182a3f8c7bbcb5f67ad05f465f4504974d3fd8ac0e517caa5fec9" as const;

const checksum = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

export async function ensureGovernedReplacementSmoke(input: {
  workspaceId: string;
  authorizationId: string;
  replacementExecutionId: string;
}): Promise<{ missionId: string; executionId: string; templateChecksum: string }> {
  const templateBytes = Uint8Array.from(await readFile(REPLACEMENT_SMOKE_TEMPLATE_PATH));
  if (checksum(templateBytes) !== REPLACEMENT_SMOKE_TEMPLATE_CHECKSUM)
    throw new Error("Replacement smoke template bytes are not approved.");
  const template = JSON.parse(Buffer.from(templateBytes).toString("utf8")) as {
    templateId: string;
    templateVersion: string;
    repositoryId: string;
    repositoryFingerprint: string;
    objective: string;
    timeoutSeconds: number;
    allowedOperations: string[];
    forbiddenOperations: string[];
    acceptanceCriteria: string[];
  };
  const claim = await getDatabasePool().query<{
    state: string;
    agent_id: string;
    authorization_record: Record<string, unknown>;
  }>(
    `SELECT c.state,c.agent_id,b.authorization_record
       FROM mission_agent_replacement_execution_claims c
       JOIN mission_agent_replacement_bootstraps b
         ON b.workspace_id=c.workspace_id AND b.authorization_id=c.authorization_id
      WHERE c.workspace_id=$1 AND c.authorization_id=$2 AND c.execution_id=$3
        AND c.completed_at IS NULL`,
    [input.workspaceId, input.authorizationId, input.replacementExecutionId],
  );
  const owner = claim.rows[0];
  if (
    !owner ||
    owner.state !== "awaiting-authoritative-smoke" ||
    owner.agent_id !== NAMED_CANARY_ID ||
    owner.authorization_record.repositoryId !== template.repositoryId ||
    owner.authorization_record.repositoryFingerprint !== template.repositoryFingerprint
  )
    throw new Error("Replacement execution is not eligible for its immutable governed smoke.");
  const missionId = stableUuid(`replacement-smoke-mission:${input.authorizationId}:${input.replacementExecutionId}`);
  const templateId = stableUuid(`replacement-smoke-template:${template.templateId}:${template.templateVersion}`);
  const taskId = stableUuid(`replacement-smoke-task:${missionId}`);
  const executionId = stableUuid(`replacement-smoke-execution:${missionId}`);
  const existing = await getDatabasePool().query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM execution_projections
        WHERE workspace_id=$1 AND execution_id=$2 AND mission_id=$3
     ) exists`,
    [input.workspaceId, executionId, missionId],
  );
  if (existing.rows[0]?.exists)
    return { missionId, executionId, templateChecksum: REPLACEMENT_SMOKE_TEMPLATE_CHECKSUM };
  const missionActor = {
    workspaceId: input.workspaceId,
    userId: "replacement-bootstrap-governance",
    role: "owner" as const,
  };
  const systemActor = {
    workspaceId: input.workspaceId,
    id: "replacement-bootstrap-governance",
    type: "system" as const,
  };
  await handleCreateMission({
    actor: missionActor,
    commandId: stableUuid(`replacement-smoke-create-mission:${missionId}`),
    missionId,
    mission: {
      name: "Mission Agent replacement read-only acceptance",
      objective: template.objective,
      description: "Immutable governed replacement-bootstrap smoke mission.",
      domain: "release-governance",
      priority: "high",
      riskLevel: "low",
      requestedOutcome: "Read-only repository evidence with no external side effects.",
      successCriteria: template.acceptanceCriteria,
      constraints: template.forbiddenOperations,
      budgetLimits: { maximumExecutions: 1, maximumSeconds: template.timeoutSeconds },
      templateId,
      templateVersion: Number(template.templateVersion),
      resolvedInputs: {
        authorizationId: input.authorizationId,
        replacementExecutionId: input.replacementExecutionId,
        templateChecksum: REPLACEMENT_SMOKE_TEMPLATE_CHECKSUM,
        repositoryId: template.repositoryId,
        repositoryFingerprint: template.repositoryFingerprint,
      },
    },
  });
  await handleCreateTask({
    actor: systemActor,
    commandId: stableUuid(`replacement-smoke-create-task:${taskId}`),
    taskId,
    task: {
      missionId,
      name: "Read-only repository identity analysis",
      instructions: template.objective,
      expectedOutput: "Checksum-bound read-only repository analysis evidence.",
      priority: "high",
      riskLevel: "low",
      requiredCapabilities: template.allowedOperations,
      requiredResources: [{ resourceType: "repository", resourceId: template.repositoryId, permission: "read" }],
      maximumAttempts: 1,
      timeoutSeconds: template.timeoutSeconds,
      approvalPolicy: {
        missionType: "analysis",
        writeApprovalRequired: false,
        replacementAuthorizationId: input.authorizationId,
        replacementExecutionId: input.replacementExecutionId,
        replacementTemplateChecksum: REPLACEMENT_SMOKE_TEMPLATE_CHECKSUM,
      },
      verificationRequirements: ["projection-replay", "artifact-checksum", "no-side-effects"],
    },
  });
  await handleTaskTransition({
    actor: systemActor,
    commandId: stableUuid(`replacement-smoke-task-ready:${taskId}`),
    taskId,
    target: "ready",
  });
  await handleMissionTransition({
    actor: missionActor,
    commandId: stableUuid(`replacement-smoke-mission-plan:${missionId}`),
    missionId,
    target: "planned",
  });
  await handleMissionTransition({
    actor: missionActor,
    commandId: stableUuid(`replacement-smoke-mission-start:${missionId}`),
    missionId,
    target: "running",
  });
  await handleRequestRemoteExecution({
    actor: systemActor,
    commandId: stableUuid(`replacement-smoke-request:${executionId}`),
    executionId,
    taskId,
    agentId: NAMED_CANARY_ID,
    timeoutSeconds: template.timeoutSeconds,
  });
  return { missionId, executionId, templateChecksum: REPLACEMENT_SMOKE_TEMPLATE_CHECKSUM };
}

export async function evaluateGovernedReplacementSmoke(input: {
  workspaceId: string;
  authorizationId: string;
  replacementExecutionId: string;
}): Promise<{
  decision: "continue";
  smokeEvidenceChecksum: string;
  missionId: string;
  executionId: string;
}> {
  const identifiers = {
    missionId: stableUuid(`replacement-smoke-mission:${input.authorizationId}:${input.replacementExecutionId}`),
    executionId: stableUuid(
      `replacement-smoke-execution:${stableUuid(
        `replacement-smoke-mission:${input.authorizationId}:${input.replacementExecutionId}`,
      )}`,
    ),
  };
  const state = await getDatabasePool().query<{
    mission_status: string;
    mission_template_id: string | null;
    mission_template_version: number | null;
    resolved_inputs: Record<string, unknown>;
    mission_aggregate_version: number;
    execution_status: string;
    execution_agent_id: string;
    execution_repository_id: string | null;
    execution_aggregate_version: number;
    execution_started_at: Date | null;
    execution_completed_at: Date | null;
    assignment_status: string;
    lease_expires_at: Date | null;
    assignment_payload: Record<string, unknown>;
    execution_count: string;
    artifact_count: string;
    invalid_artifact_count: string;
    side_effect_count: string;
    heartbeat_count: string;
    mission_event_version: number;
    execution_event_version: number;
  }>(
    `SELECT m.status mission_status,m.template_id mission_template_id,
            m.template_version mission_template_version,m.resolved_inputs,
            m.aggregate_version mission_aggregate_version,e.status execution_status,
            e.agent_id execution_agent_id,e.repository_id execution_repository_id,
            e.aggregate_version execution_aggregate_version,
            e.started_at execution_started_at,e.completed_at execution_completed_at,
            p.status assignment_status,p.lease_expires_at,p.payload assignment_payload,
            (SELECT count(*)::text FROM execution_projections x
              WHERE x.workspace_id=$1 AND x.mission_id=$2) execution_count,
            (SELECT count(*)::text FROM artifacts a
              WHERE a.workspace_id=$1 AND a.execution_id=$3 AND a.deleted_at IS NULL) artifact_count,
            (SELECT count(*)::text FROM artifacts a
              WHERE a.workspace_id=$1 AND a.execution_id=$3 AND a.deleted_at IS NULL
                AND a.checksum_sha256 !~ '^[a-f0-9]{64}$') invalid_artifact_count,
            ((SELECT count(*) FROM action_request_projections action
                WHERE action.workspace_id=$1 AND action.mission_id=$2) +
             (SELECT count(*) FROM publication_assignments publication
                WHERE publication.workspace_id=$1 AND publication.mission_id=$2) +
             (SELECT count(*) FROM outbox queued
                WHERE queued.workspace_id=$1
                  AND (queued.payload->>'missionId'=$2::text OR queued.payload->>'executionId'=$3::text)
                  AND (queued.topic ILIKE '%action%' OR queued.topic ILIKE '%publication%' OR
                       queued.topic ILIKE '%deploy%' OR queued.topic ILIKE '%push%')) +
             (SELECT count(*) FROM jobs queued_job
                WHERE queued_job.workspace_id=$1
                  AND (queued_job.payload->>'missionId'=$2::text OR
                       queued_job.payload->>'executionId'=$3::text)
                  AND queued_job.job_type IN ('execute_action')) +
             (SELECT count(*) FROM events side
                WHERE side.workspace_id=$1 AND side.mission_id=$2 AND side.event_type IN (
                  'action.requested','action.approved','action.execution_started',
                  'repository.push_requested','repository.pull_request_requested',
                  'repository.push_completed','repository.pull_request_created',
                  'publication.requested','deployment.requested',
                  'publication.completed','deployment.completed','approval.granted'
                )))::text side_effect_count,
            (SELECT count(*)::text FROM events heartbeat
              WHERE heartbeat.workspace_id=$1 AND heartbeat.aggregate_type='execution'
                AND heartbeat.aggregate_id=$3 AND heartbeat.event_type='execution.progress_reported'
                AND heartbeat.payload->>'heartbeat'='true'
                AND heartbeat.aggregate_version >
                  (SELECT accepted.aggregate_version FROM events accepted
                    WHERE accepted.workspace_id=$1 AND accepted.aggregate_type='execution'
                      AND accepted.aggregate_id=$3 AND accepted.event_type='execution.accepted'
                    ORDER BY accepted.aggregate_version DESC LIMIT 1)
                AND heartbeat.aggregate_version <
                  (SELECT succeeded.aggregate_version FROM events succeeded
                    WHERE succeeded.workspace_id=$1 AND succeeded.aggregate_type='execution'
                      AND succeeded.aggregate_id=$3 AND succeeded.event_type='execution.succeeded'
                    ORDER BY succeeded.aggregate_version DESC LIMIT 1)) heartbeat_count,
            (SELECT max(aggregate_version) FROM events
              WHERE workspace_id=$1 AND aggregate_type='mission' AND aggregate_id=$2) mission_event_version,
            (SELECT max(aggregate_version) FROM events
              WHERE workspace_id=$1 AND aggregate_type='execution' AND aggregate_id=$3) execution_event_version
       FROM mission_projections m
       JOIN execution_projections e ON e.workspace_id=m.workspace_id AND e.execution_id=$3
       JOIN pull_assignments p ON p.workspace_id=e.workspace_id AND p.execution_id=e.execution_id
      WHERE m.workspace_id=$1 AND m.mission_id=$2`,
    [input.workspaceId, identifiers.missionId, identifiers.executionId],
  );
  const row = state.rows[0];
  const artifactRows = await getDatabasePool().query<{ artifact_id: string }>(
    `SELECT artifact_id FROM artifacts
      WHERE workspace_id=$1 AND execution_id=$2 AND deleted_at IS NULL
      ORDER BY artifact_id`,
    [input.workspaceId, identifiers.executionId],
  );
  const verifiedArtifacts = await Promise.all(
    artifactRows.rows.map((artifact) => readExecutionArtifact(input.workspaceId, artifact.artifact_id)),
  );
  const artifactBytesVerified =
    verifiedArtifacts.length > 0 && verifiedArtifacts.every((artifact) => artifact !== undefined);
  const [missionEvents, executionEvents] = await Promise.all([
    loadAggregateEvents({
      workspaceId: input.workspaceId,
      aggregateType: "mission",
      aggregateId: identifiers.missionId,
    }),
    loadAggregateEvents({
      workspaceId: input.workspaceId,
      aggregateType: "execution",
      aggregateId: identifiers.executionId,
    }),
  ]);
  const replayedMission = rehydrateMission(missionEvents);
  const replayedExecution = rehydrateExecution(executionEvents);
  const missionCreated = missionEvents.find((event) => event.eventType === "mission.created");
  const missionProjectionReplayEqual =
    !!row &&
    replayedMission?.status === row.mission_status &&
    replayedMission?.version === row.mission_aggregate_version &&
    missionCreated?.payload.templateId === row.mission_template_id &&
    missionCreated?.payload.templateVersion === row.mission_template_version &&
    canonicalJson(missionCreated?.payload.resolvedInputs ?? {}) === canonicalJson(row.resolved_inputs);
  const executionProjectionReplayEqual =
    !!row &&
    replayedExecution?.status === row.execution_status &&
    replayedExecution?.version === row.execution_aggregate_version &&
    replayedExecution?.agentId === row.execution_agent_id &&
    replayedExecution?.missionId === identifiers.missionId;
  if (
    !row ||
    row.mission_status !== "completed" ||
    row.mission_template_id !== stableUuid("replacement-smoke-template:replacement-bootstrap-read-only-v1:1") ||
    row.mission_template_version !== 1 ||
    row.resolved_inputs.authorizationId !== input.authorizationId ||
    row.resolved_inputs.replacementExecutionId !== input.replacementExecutionId ||
    row.resolved_inputs.templateChecksum !== REPLACEMENT_SMOKE_TEMPLATE_CHECKSUM ||
    row.execution_status !== "succeeded" ||
    row.execution_agent_id !== NAMED_CANARY_ID ||
    row.execution_repository_id !== String(row.resolved_inputs.repositoryId) ||
    !row.execution_started_at ||
    !row.execution_completed_at ||
    row.assignment_status !== "completed" ||
    row.lease_expires_at !== null ||
    row.assignment_payload.replacementTemplateChecksum !== REPLACEMENT_SMOKE_TEMPLATE_CHECKSUM ||
    Number(row.execution_count) !== 1 ||
    Number(row.artifact_count) < 1 ||
    !artifactBytesVerified ||
    Number(row.invalid_artifact_count) !== 0 ||
    Number(row.side_effect_count) !== 0 ||
    Number(row.heartbeat_count) < 1 ||
    row.mission_event_version !== row.mission_aggregate_version ||
    row.execution_event_version !== row.execution_aggregate_version ||
    !missionProjectionReplayEqual ||
    !executionProjectionReplayEqual
  )
    throw new Error(
      `Governed replacement smoke has not reached authoritative acceptance: ${canonicalJson({
        rowPresent: !!row,
        missionCompleted: row?.mission_status === "completed",
        executionSucceeded: row?.execution_status === "succeeded",
        assignmentCompleted: row?.assignment_status === "completed",
        executionCount: Number(row?.execution_count ?? 0),
        artifactCount: Number(row?.artifact_count ?? 0),
        artifactBytesVerified,
        invalidArtifactCount: Number(row?.invalid_artifact_count ?? 0),
        sideEffectCount: Number(row?.side_effect_count ?? 0),
        heartbeatCount: Number(row?.heartbeat_count ?? 0),
        missionProjectionReplayEqual,
        executionProjectionReplayEqual,
      })}`,
    );
  const evidence = {
    evidenceVersion: "replacement-authoritative-smoke-v1",
    authorizationId: input.authorizationId,
    replacementExecutionId: input.replacementExecutionId,
    missionId: identifiers.missionId,
    executionId: identifiers.executionId,
    agentId: row.execution_agent_id,
    templateChecksum: REPLACEMENT_SMOKE_TEMPLATE_CHECKSUM,
    assignmentStatus: row.assignment_status,
    executionStatus: row.execution_status,
    missionStatus: row.mission_status,
    artifactCount: Number(row.artifact_count),
    artifactBytesVerified,
    sideEffectCount: 0,
    duplicateExecutionCount: 0,
    activeLeaseCount: 0,
    missionProjectionReplayEqual,
    executionProjectionReplayEqual,
  };
  const smokeEvidenceChecksum = createHash("sha256").update(canonicalJson(evidence)).digest("hex");
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const claim = await client.query<{ expires_at: Date }>(
      `SELECT expires_at FROM mission_agent_replacement_execution_claims
        WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3
          AND state='awaiting-authoritative-smoke' AND completed_at IS NULL FOR UPDATE`,
      [input.workspaceId, input.authorizationId, input.replacementExecutionId],
    );
    if (!claim.rows[0]) throw new Error("Replacement claim is no longer awaiting smoke.");
    await client.query(
      `INSERT INTO mission_agent_replacement_evidence(
        workspace_id,authorization_id,execution_id,evidence_type,evidence_checksum,evidence,
        observed_at,expires_at
      ) VALUES($1,$2,$3,'smoke',$4,$5::jsonb,clock_timestamp(),$6)`,
      [
        input.workspaceId,
        input.authorizationId,
        input.replacementExecutionId,
        smokeEvidenceChecksum,
        JSON.stringify(evidence),
        claim.rows[0].expires_at,
      ],
    );
    await client.query(
      `UPDATE mission_agent_replacement_execution_claims SET state='ready:report_evidence'
        WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3`,
      [input.workspaceId, input.authorizationId, input.replacementExecutionId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return {
    decision: "continue",
    smokeEvidenceChecksum,
    missionId: identifiers.missionId,
    executionId: identifiers.executionId,
  };
}
