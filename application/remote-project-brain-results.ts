import { createHash, randomUUID } from "node:crypto";
import { canonicalHash } from "@/lib/canonical-json";
import { getDatabasePool, withTransaction } from "@/lib/database";
import { ValidationFailedError } from "@/lib/application-errors";
import { appendProjectBrainOperationEvent } from "./project-brain-commands";
import { completeRemoteProjectBrainAssignment } from "./remote-project-brain-assignments";
import { stableUuid } from "@/lib/stable-id";
import { storeExecutionArtifact } from "@/execution/artifact-store";
import { createPullAssignment } from "@/application/pull-assignments";

const digest = (value: Buffer) => createHash("sha256").update(new Uint8Array(value)).digest("hex");
const safePath = (value: string) =>
  value.length > 0 && !value.startsWith("/") && !value.split("/").some((part) => part === ".." || part === "");
const artifactKinds: Record<string, string[]> = {
  initialize_repository: ["project_brain_initialization"],
  prepare_context: ["context_pack"],
  read_context: ["context_pack"],
  record_closure: ["mission_result"],
  propose_learning: ["proposed_learning"],
  evaluate_learning: ["knowledge_evaluation"],
};

type Assignment = {
  assignment_id: string;
  operation_id: string;
  repository_id: string;
  mission_id: string | null;
  execution_id: string | null;
  agent_id: string;
  status: string;
  accepted_event_emitted: boolean;
  started_event_emitted: boolean;
  request: Record<string, unknown>;
  request_checksum: string;
};

async function assignmentFor(
  message: {
    payload: Record<string, unknown>;
    agentId: string;
    missionId?: string;
    executionId?: string;
  },
  workspaceId: string,
) {
  const row = (
    await getDatabasePool().query<Assignment>(
      `SELECT * FROM remote_project_brain_assignments
       WHERE workspace_id=$1 AND assignment_id=$2 AND operation_id=$3 AND agent_id=$4`,
      [
        workspaceId,
        String(message.payload.assignmentId ?? ""),
        String(message.payload.operationId ?? ""),
        message.agentId,
      ],
    )
  ).rows[0];
  if (
    !row ||
    (row.mission_id ?? undefined) !== message.missionId ||
    (row.execution_id ?? undefined) !== message.executionId
  )
    throw new ValidationFailedError("Remote Project Brain result identity mismatch");
  return row;
}

export function validateRemoteProjectBrainResultEnvelope(value: unknown, assignment: Assignment) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ValidationFailedError("Remote Project Brain result must be an object");
  const response = value as Record<string, unknown>;
  const envelope = response.envelope as Record<string, unknown> | undefined;
  const repository = envelope?.repository as Record<string, unknown> | undefined;
  const process = response.process as Record<string, unknown> | undefined;
  const artifactCommit = response.artifactCommit as Record<string, unknown> | undefined;
  const request = assignment.request;
  const requiredSchemas = request.requiredSchemaVersions as string[];
  const startedAt = Date.parse(String(response.startedAt ?? ""));
  const completedAt = Date.parse(String(response.completedAt ?? ""));
  const versionedMutation =
    request.artifactVersioning === true &&
    (envelope?.repository_files_changed === true ||
      (Array.isArray(envelope?.artifacts) && envelope.artifacts.length > 0));
  if (
    response.requestId !== request.requestId ||
    response.idempotencyKey !== request.idempotencyKey ||
    response.requestChecksum !== assignment.request_checksum ||
    typeof response.responseChecksum !== "string" ||
    !/^[a-f0-9]{64}$/.test(response.responseChecksum) ||
    !envelope ||
    envelope.operation !== request.operation ||
    envelope.contract_version !== request.requiredContractVersion ||
    envelope.status !== "succeeded" ||
    response.startingSha !== request.startingSha ||
    (versionedMutation
      ? !artifactCommit ||
        artifactCommit.parentSha !== request.startingSha ||
        artifactCommit.commitSha !== response.endingSha ||
        !Array.isArray(artifactCommit.paths)
      : response.endingSha !== request.startingSha || artifactCommit !== undefined) ||
    response.projectBrainVersion !== request.requiredProjectBrainVersion ||
    !Array.isArray(response.schemaVersions) ||
    requiredSchemas.some((version) => !(response.schemaVersions as unknown[]).includes(version)) ||
    !repository ||
    repository.id !== assignment.repository_id ||
    repository.checkout_path !== request.repositoryLocator ||
    repository.head_sha !== request.startingSha ||
    repository.ending_head_sha !== response.endingSha ||
    !process ||
    process.exitCode !== 0 ||
    !/^[a-f0-9]{64}$/.test(String(process.stdoutSha256 ?? "")) ||
    !/^[a-f0-9]{64}$/.test(String(process.stderrSha256 ?? "")) ||
    !Number.isInteger(response.durationMs) ||
    Number(response.durationMs) < 0 ||
    Number(response.durationMs) > Number(request.timeoutMs) + 5_000 ||
    !Number.isFinite(startedAt) ||
    !Number.isFinite(completedAt) ||
    completedAt < startedAt ||
    !Array.isArray(envelope.artifacts) ||
    !Array.isArray(envelope.warnings) ||
    !Array.isArray(envelope.blockers) ||
    typeof envelope.repository_files_changed !== "boolean" ||
    typeof envelope.exit_classification !== "string"
  )
    throw new ValidationFailedError("Invalid remote Project Brain consumer envelope");
  const unsigned = { ...response };
  delete unsigned.responseChecksum;
  if (canonicalHash(unsigned) !== response.responseChecksum)
    throw new ValidationFailedError("Remote Project Brain response checksum mismatch");
  return { response, envelope };
}

async function dispatchVerifiedContext(input: {
  workspaceId: string;
  messageId: string;
  agentId: string;
  assignment: Assignment;
  base: Record<string, unknown>;
  context: Record<string, unknown>;
  body: Buffer;
  contractVersion: unknown;
  executionStartingSha: string;
}) {
  const { workspaceId, assignment, context } = input;
  const current = (
    await getDatabasePool().query<{ observed_commit: string }>(
      `SELECT observed_commit FROM repositories WHERE workspace_id=$1 AND repository_id=$2
       AND disabled_at IS NULL`,
      [workspaceId, assignment.repository_id],
    )
  ).rows[0];
  if (!current || current.observed_commit !== input.executionStartingSha) {
    await appendProjectBrainOperationEvent({
      actor: { workspaceId, id: input.agentId, type: "agent" },
      operationId: assignment.operation_id,
      commandId: stableUuid(`remote-pb:${assignment.operation_id}:head-changed`),
      event: {
        eventType: "project_brain.remote_repository_head_changed",
        eventSchemaVersion: 1,
        payload: {
          ...input.base,
          operationStatus: "succeeded",
          expectedSha: input.executionStartingSha,
          observedSha: current?.observed_commit ?? null,
          missionProjection: { contextBoundStatus: "stale" },
        },
      },
    });
    return;
  }
  await appendProjectBrainOperationEvent({
    actor: { workspaceId, id: input.agentId, type: "agent" },
    operationId: assignment.operation_id,
    commandId: stableUuid(`remote-pb:${assignment.operation_id}:context-verified`),
    event: {
      eventType: "project_brain.remote_context_verified",
      eventSchemaVersion: 1,
      payload: {
        ...input.base,
        operationStatus: "succeeded",
        contextChecksum: context.sha256,
        startingSha: input.executionStartingSha,
        sourceContextSha: assignment.request.startingSha,
        missionProjection: {
          contextBoundStatus: "bound",
          boundExecutionId: assignment.execution_id,
          assignedAgentId: assignment.agent_id,
          boundAt: new Date().toISOString(),
        },
      },
    },
  });
  await withTransaction(async (client) => {
    const pending = (
      await client.query<{
        mission_id: string;
        task_id: string;
        agent_id: string;
        attempt: number;
        task_envelope: Record<string, unknown>;
        status: string;
      }>(
        `SELECT * FROM remote_project_brain_execution_dispatches
         WHERE workspace_id=$1 AND execution_id=$2 FOR UPDATE`,
        [workspaceId, assignment.execution_id],
      )
    ).rows[0];
    if (!pending || pending.status === "dispatched") return;
    await createPullAssignment(client, {
      workspaceId,
      executionId: assignment.execution_id!,
      missionId: pending.mission_id,
      taskId: pending.task_id,
      agentId: pending.agent_id,
      attempt: pending.attempt,
      payload: {
        ...pending.task_envelope,
        projectBrainContext: {
          artifactId: context.artifactId,
          contentBase64: input.body.toString("base64"),
          checksum: context.sha256,
          schemaVersion: context.schema_version,
          contractVersion: input.contractVersion,
          startingSha: input.executionStartingSha,
          sourceContextSha: assignment.request.startingSha,
          repositoryFingerprint: assignment.request.repositoryFingerprint,
          repositoryPath: context.path,
          contextBytes: input.body.byteLength,
          verificationRequired: true,
        },
      },
    });
    await client.query(
      `UPDATE remote_project_brain_execution_dispatches SET status='dispatched',
        context_artifact_id=$3,context_checksum=$4,starting_sha=$5,dispatched_at=now(),updated_at=now()
       WHERE workspace_id=$1 AND execution_id=$2`,
      [workspaceId, assignment.execution_id, context.artifactId, context.sha256, input.executionStartingSha],
    );
  });
}

export async function processRemoteProjectBrainMessage(
  message: {
    messageType: string;
    messageId: string;
    agentId: string;
    missionId?: string;
    executionId?: string;
    payload: Record<string, unknown>;
  },
  workspaceId: string,
) {
  const assignment = await assignmentFor(message, workspaceId);
  if (["succeeded", "failed"].includes(assignment.status)) return { status: assignment.status, duplicate: true };
  const base = {
    repositoryId: assignment.repository_id,
    operation: assignment.request.operation,
    agentId: assignment.agent_id,
    assignmentId: assignment.assignment_id,
    requestChecksum: assignment.request_checksum,
  };
  if (message.messageType === "RemoteProjectBrainOperationAccepted") {
    if (assignment.accepted_event_emitted || !["leased", "acknowledged"].includes(assignment.status))
      return { status: assignment.status, duplicate: true };
    await appendProjectBrainOperationEvent({
      actor: { workspaceId, id: message.agentId, type: "agent" },
      operationId: assignment.operation_id,
      commandId: stableUuid(`remote-pb:${assignment.assignment_id}:accepted`),
      event: {
        eventType: "project_brain.remote_operation_accepted",
        eventSchemaVersion: 1,
        payload: { ...base, operationStatus: "accepted" },
      },
    });
    await getDatabasePool().query(
      `UPDATE remote_project_brain_assignments SET status='acknowledged',
         accepted_event_emitted=true,updated_at=now()
       WHERE workspace_id=$1 AND assignment_id=$2 AND status IN('leased','acknowledged')`,
      [workspaceId, assignment.assignment_id],
    );
    return { status: "accepted" };
  }
  if (message.messageType === "RemoteProjectBrainOperationStarted") {
    if (assignment.started_event_emitted || !["leased", "acknowledged", "running"].includes(assignment.status))
      return { status: assignment.status, duplicate: true };
    if (!assignment.accepted_event_emitted) {
      await appendProjectBrainOperationEvent({
        actor: { workspaceId, id: message.agentId, type: "agent" },
        operationId: assignment.operation_id,
        commandId: stableUuid(`remote-pb:${assignment.assignment_id}:accepted`),
        event: {
          eventType: "project_brain.remote_operation_accepted",
          eventSchemaVersion: 1,
          payload: { ...base, operationStatus: "accepted" },
        },
      });
      await getDatabasePool().query(
        `UPDATE remote_project_brain_assignments SET status='acknowledged',
           accepted_event_emitted=true,updated_at=now()
         WHERE workspace_id=$1 AND assignment_id=$2 AND status IN('leased','acknowledged')`,
        [workspaceId, assignment.assignment_id],
      );
    }
    await appendProjectBrainOperationEvent({
      actor: { workspaceId, id: message.agentId, type: "agent" },
      operationId: assignment.operation_id,
      commandId: stableUuid(`remote-pb:${assignment.assignment_id}:started`),
      event: {
        eventType: "project_brain.remote_operation_started",
        eventSchemaVersion: 1,
        payload: { ...base, operationStatus: "started", startingSha: assignment.request.startingSha },
      },
    });
    await getDatabasePool().query(
      `UPDATE remote_project_brain_assignments SET status='running',
         started_event_emitted=true,updated_at=now()
       WHERE workspace_id=$1 AND assignment_id=$2 AND status IN('leased','acknowledged','running')`,
      [workspaceId, assignment.assignment_id],
    );
    return { status: "started" };
  }
  if (message.messageType === "RemoteProjectBrainOperationSucceeded") {
    const { response, envelope } = validateRemoteProjectBrainResultEnvelope(message.payload.response, assignment);
    const operationArguments = (assignment.request.arguments as Record<string, unknown>) ?? {};
    const artifactCommit = response.artifactCommit as Record<string, unknown> | undefined;
    const responseArtifacts = envelope.artifacts as Array<Record<string, unknown>>;
    const committedChecksums = artifactCommit?.checksums as Record<string, unknown> | undefined;
    if (
      artifactCommit &&
      ((artifactCommit.paths as unknown[]).length !== responseArtifacts.length ||
        (artifactCommit.paths as unknown[]).some(
          (path) =>
            !responseArtifacts.some(
              (artifact) => artifact.path === path && committedChecksums?.[String(path)] === artifact.sha256,
            ),
        ))
    )
      throw new ValidationFailedError("Remote Project Brain artifact commit scope mismatch");
    if (assignment.request.operation === "prepare_context" && operationArguments.preview !== true) {
      const pack = (envelope.data as Record<string, unknown> | undefined)?.context_pack as
        Record<string, unknown> | undefined;
      const binding = pack?.consumer_binding as Record<string, unknown> | undefined;
      if (
        !binding ||
        binding.mission_id !== assignment.mission_id ||
        binding.execution_id !== assignment.execution_id ||
        binding.starting_sha !== assignment.request.startingSha
      ) {
        await appendProjectBrainOperationEvent({
          actor: { workspaceId, id: message.agentId, type: "agent" },
          operationId: assignment.operation_id,
          commandId: stableUuid(`remote-pb:${message.messageId}:context-mismatch`),
          event: {
            eventType: "project_brain.remote_context_mismatch",
            eventSchemaVersion: 1,
            payload: {
              ...base,
              operationStatus: "started",
              failureCause: "context_consumer_binding_mismatch",
              expectedMissionId: assignment.mission_id,
              expectedExecutionId: assignment.execution_id,
              expectedStartingSha: assignment.request.startingSha,
            },
          },
        });
        throw new ValidationFailedError("Remote Project Brain context consumer binding mismatch");
      }
    }
    const artifacts = envelope.artifacts as Array<Record<string, unknown>>;
    const requiredSchemas = assignment.request.requiredSchemaVersions as string[];
    const stored: Array<Record<string, unknown>> = [];
    const artifactBodies = new Map<string, Buffer>();
    let totalArtifactBytes = 0;
    const validatedArtifacts: Array<{
      artifact: Record<string, unknown>;
      repositoryPath: string;
      body: Buffer;
    }> = [];
    for (const artifact of artifacts) {
      const repositoryPath = String(artifact.path ?? "");
      const body =
        artifact.transfer_mode === "inline_base64" && typeof artifact.content_base64 === "string"
          ? Buffer.from(artifact.content_base64, "base64")
          : null;
      totalArtifactBytes += body?.byteLength ?? 0;
      if (
        !safePath(repositoryPath) ||
        !body ||
        !(artifactKinds[String(assignment.request.operation)] ?? []).includes(String(artifact.kind)) ||
        !requiredSchemas.includes(String(artifact.schema_version ?? "")) ||
        artifact.repository_sha !== response.endingSha ||
        !/^[a-f0-9]{64}$/.test(String(artifact.sha256 ?? "")) ||
        digest(body) !== artifact.sha256 ||
        body.byteLength !== Number(artifact.size) ||
        totalArtifactBytes > Number(assignment.request.maxOutputBytes)
      ) {
        await appendProjectBrainOperationEvent({
          actor: { workspaceId, id: message.agentId, type: "agent" },
          operationId: assignment.operation_id,
          commandId: stableUuid(`remote-pb:${message.messageId}:artifact-rejected`),
          event: {
            eventType: "project_brain.remote_artifact_rejected",
            eventSchemaVersion: 1,
            payload: {
              ...base,
              operationStatus: "started",
              artifactKind: artifact.kind,
              repositoryPath: safePath(repositoryPath) ? repositoryPath : null,
              claimedChecksum: artifact.sha256,
              failureCause: "artifact_integrity_validation_failed",
            },
          },
        });
        throw new ValidationFailedError("Remote Project Brain artifact failed integrity validation");
      }
      validatedArtifacts.push({ artifact, repositoryPath, body });
    }
    const repositoryTransition = await getDatabasePool().query(
      `UPDATE repositories SET observed_commit=$4,updated_at=now()
       WHERE workspace_id=$1 AND repository_id=$2 AND disabled_at IS NULL
         AND ($6::boolean OR $3::jsonb <@ allowed_agent_ids) AND observed_commit IN($5,$4)
       RETURNING repository_id`,
      [
        workspaceId,
        assignment.repository_id,
        JSON.stringify([assignment.agent_id]),
        response.endingSha,
        assignment.request.startingSha,
        assignment.started_event_emitted,
      ],
    );
    if (!repositoryTransition.rowCount)
      throw new ValidationFailedError("Remote Project Brain repository transition is stale or unauthorized");
    await withTransaction(async (client) => {
      for (const { artifact, repositoryPath, body } of validatedArtifacts) {
        const candidateArtifactId = randomUUID();
        const inserted = (
          await client.query<{ artifact_id: string; byte_size: number; sha256: string }>(
            `INSERT INTO remote_project_brain_artifacts(
             workspace_id,artifact_id,operation_id,repository_id,mission_id,execution_id,kind,
             repository_path,schema_version,repository_sha,byte_size,sha256,content
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT(workspace_id,operation_id,kind,repository_path) DO NOTHING
           RETURNING artifact_id,byte_size,sha256`,
            [
              workspaceId,
              candidateArtifactId,
              assignment.operation_id,
              assignment.repository_id,
              assignment.mission_id,
              assignment.execution_id,
              String(artifact.kind),
              repositoryPath,
              String(artifact.schema_version),
              String(artifact.repository_sha ?? response.endingSha),
              body.byteLength,
              artifact.sha256,
              body,
            ],
          )
        ).rows[0];
        const persisted =
          inserted ??
          (
            await client.query<{ artifact_id: string; byte_size: number; sha256: string }>(
              `SELECT artifact_id,byte_size,sha256 FROM remote_project_brain_artifacts
               WHERE workspace_id=$1 AND operation_id=$2 AND kind=$3 AND repository_path=$4`,
              [workspaceId, assignment.operation_id, String(artifact.kind), repositoryPath],
            )
          ).rows[0];
        if (!persisted || persisted.sha256 !== artifact.sha256 || Number(persisted.byte_size) !== body.byteLength)
          throw new ValidationFailedError("Remote Project Brain artifact replay did not match persisted bytes");
        stored.push({
          ...artifact,
          artifactId: persisted.artifact_id,
          byteSize: body.byteLength,
          content_base64: undefined,
        });
        artifactBodies.set(`${String(artifact.kind)}\n${repositoryPath}`, body);
      }
    });
    let context = stored.find((artifact) =>
      ["project_brain_context", "project_brain_context_pack", "context_pack"].includes(String(artifact.kind)),
    );
    if (context && assignment.mission_id && assignment.execution_id) {
      const taskId = (
        await getDatabasePool().query<{ task_id: string }>(
          `SELECT task_id FROM execution_projections WHERE workspace_id=$1 AND execution_id=$2`,
          [workspaceId, assignment.execution_id],
        )
      ).rows[0]?.task_id;
      if (!taskId) throw new ValidationFailedError("Remote context execution binding is unavailable");
      const persisted = await storeExecutionArtifact({
        workspaceId,
        missionId: assignment.mission_id,
        taskId,
        executionId: assignment.execution_id,
        kind: String(context.kind),
        mediaType: "text/markdown",
        body: artifactBodies.get(`${String(context.kind)}\n${String(context.path)}`)!,
        maxBytes: Number(assignment.request.maxOutputBytes),
        idempotencyKey: `remote-project-brain:${assignment.operation_id}:${String(context.sha256)}`,
        metadata: {
          repositoryPath: context.path,
          schemaVersion: context.schema_version,
          contractVersion: envelope.contract_version,
          startingSha: assignment.request.startingSha,
          projectBrainOperationId: assignment.operation_id,
          remoteArtifactChecksum: context.sha256,
        },
      });
      context = { ...context, artifactId: persisted.artifactId, byteSize: persisted.byteSize };
      const index = stored.findIndex((artifact) => artifact.kind === context!.kind && artifact.path === context!.path);
      stored[index] = context;
    }
    const preview = (assignment.request.arguments as Record<string, unknown> | undefined)?.preview === true;
    const operation = String(assignment.request.operation);
    const eventType =
      operation === "prepare_context"
        ? "project_brain.context_generated"
        : operation === "record_closure"
          ? "project_brain.closure_recorded"
          : operation === "propose_learning"
            ? "project_brain.learning_proposed"
            : operation === "evaluate_learning"
              ? "project_brain.learning_evaluated"
              : "project_brain.operation_succeeded";
    await appendProjectBrainOperationEvent({
      actor: { workspaceId, id: message.agentId, type: "agent" },
      operationId: assignment.operation_id,
      commandId: stableUuid(`remote-pb:${assignment.operation_id}:success`),
      event: {
        eventType,
        eventSchemaVersion: 1,
        payload: {
          ...base,
          operationStatus: "succeeded",
          endingSha: response.endingSha,
          warnings: envelope.warnings,
          result: {
            envelope: { ...envelope, artifacts: stored },
            remoteAudit: {
              startedAt: response.startedAt,
              completedAt: response.completedAt,
              durationMs: response.durationMs,
              process: response.process,
              responseChecksum: response.responseChecksum,
              artifactCommit: response.artifactCommit,
            },
          },
          repositoryProjection: {
            availabilityState: "available",
            compatibilityState: "compatible",
            lastValidationStatus: operation === "validate_repository" ? envelope.status : undefined,
            lastValidatedSha: operation === "validate_repository" ? response.endingSha : undefined,
            projectBrainVersion: response.projectBrainVersion,
            contractVersion: envelope.contract_version,
            schemaVersions: Array.from(new Set(stored.map((a) => String(a.schema_version)))),
            currentStateFreshness: "current",
          },
          missionProjection:
            operation === "prepare_context" && preview && !context
              ? {
                  contextPreviewStatus: "available",
                  selectedSourceManifest:
                    (
                      ((envelope.data as Record<string, unknown>)?.context_pack as Record<string, unknown> | undefined)
                        ?.selection as Record<string, unknown> | undefined
                    )?.sources ?? [],
                  contextQuality:
                    ((envelope.data as Record<string, unknown>)?.context_pack as Record<string, unknown> | undefined)
                      ?.context_quality ?? {},
                }
              : context
                ? preview
                  ? { contextPreviewStatus: "available" }
                  : {
                      contextPreviewStatus: "final",
                      finalContextArtifactId: context.artifactId,
                      contextRepositoryPath: context.path,
                      contextChecksum: context.sha256,
                      contextSchemaVersion: context.schema_version,
                      contractVersion: envelope.contract_version,
                      startingSha: response.endingSha,
                      sourceContextSha: assignment.request.startingSha,
                      contextBytes: context.byteSize,
                      selectedSourceManifest:
                        (
                          (
                            (envelope.data as Record<string, unknown>)?.context_pack as
                              Record<string, unknown> | undefined
                          )?.selection as Record<string, unknown> | undefined
                        )?.sources ?? [],
                      contextQuality:
                        (
                          (envelope.data as Record<string, unknown>)?.context_pack as
                            Record<string, unknown> | undefined
                        )?.context_quality ?? {},
                    }
                : operation === "record_closure"
                  ? { closureStatus: "recorded" }
                  : operation === "propose_learning"
                    ? { learningProposalStatus: "proposed" }
                    : operation === "evaluate_learning"
                      ? { evaluationStatus: "evaluated" }
                      : undefined,
        },
      },
    });
    for (const artifact of stored)
      await appendProjectBrainOperationEvent({
        actor: { workspaceId, id: message.agentId, type: "agent" },
        operationId: assignment.operation_id,
        commandId: stableUuid(
          `remote-pb:${assignment.operation_id}:artifact:${String(artifact.sha256)}:${String(artifact.path)}`,
        ),
        event: {
          eventType: "project_brain.remote_artifact_received",
          eventSchemaVersion: 1,
          payload: {
            ...base,
            operationStatus: "succeeded",
            artifactId: artifact.artifactId,
            artifactKind: artifact.kind,
            repositoryPath: artifact.path,
            byteSize: artifact.byteSize,
            checksum: artifact.sha256,
            schemaVersion: artifact.schema_version,
            repositorySha: artifact.repository_sha,
          },
        },
      });
    if (artifactCommit)
      await appendProjectBrainOperationEvent({
        actor: { workspaceId, id: message.agentId, type: "agent" },
        operationId: assignment.operation_id,
        commandId: stableUuid(`remote-pb:${assignment.operation_id}:artifact-versioned`),
        event: {
          eventType: "project_brain.remote_artifacts_versioned",
          eventSchemaVersion: 1,
          payload: {
            ...base,
            operationStatus: "succeeded",
            parentSha: artifactCommit.parentSha,
            commitSha: artifactCommit.commitSha,
            repositoryPaths: artifactCommit.paths,
          },
        },
      });
    if (context && !preview && assignment.mission_id && assignment.execution_id)
      await dispatchVerifiedContext({
        workspaceId,
        messageId: message.messageId,
        agentId: message.agentId,
        assignment,
        base,
        context,
        body: artifactBodies.get(`${String(context.kind)}\n${String(context.path)}`)!,
        contractVersion: envelope.contract_version,
        executionStartingSha: String(response.endingSha),
      });
    await completeRemoteProjectBrainAssignment({
      workspaceId,
      assignmentId: assignment.assignment_id,
      status: "succeeded",
      response,
    });
    return { status: "succeeded", artifactCount: stored.length };
  }
  const response = (message.payload.response as Record<string, unknown>) ?? { error: message.payload.error };
  const denied = message.messageType === "RemoteProjectBrainOperationDenied";
  await appendProjectBrainOperationEvent({
    actor: { workspaceId, id: message.agentId, type: "agent" },
    operationId: assignment.operation_id,
    commandId: stableUuid(`remote-pb:${assignment.operation_id}:failed`),
    event: {
      eventType: denied ? "project_brain.remote_operation_denied" : "project_brain.remote_operation_failed",
      eventSchemaVersion: 1,
      payload: {
        ...base,
        operationStatus: denied ? "denied" : "failed",
        failureCause: String(message.payload.error ?? "remote_failure"),
      },
    },
  });
  await completeRemoteProjectBrainAssignment({
    workspaceId,
    assignmentId: assignment.assignment_id,
    status: "failed",
    response,
  });
  return { status: "failed" };
}
