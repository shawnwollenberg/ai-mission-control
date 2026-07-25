import { createHash } from "node:crypto";
import path from "node:path";
import { readFile, realpath } from "node:fs/promises";
import { getDatabasePool } from "@/lib/database";
import { runSafeProcess } from "@/execution/safe-process";
import { ProjectBrainClient, ProjectBrainAdapterError } from "./client";
import { getProjectBrainConfiguration } from "./config";
import {
  approvalPermitsProjectBrainOperation,
  projectBrainOperationPolicy,
  projectBrainRequestFingerprint,
} from "./governance";
import { appendProjectBrainOperationEvent } from "@/application/project-brain-commands";
import { consumeApproval } from "@/application/approval-commands";
import { storeExecutionArtifact } from "@/execution/artifact-store";
import { stableUuid } from "@/lib/stable-id";
import { dispatchRemoteProjectBrainOperation } from "./remote-dispatch";

type OperationRow = {
  operation_id: string;
  repository_id: string;
  mission_id: string | null;
  execution_id: string | null;
  agent_id: string | null;
  operation: import("./types").ProjectBrainOperation;
  location_mode: "server" | "mission_agent";
  status: string;
  request: Record<string, unknown>;
  request_fingerprint: string;
  starting_sha: string | null;
  required_project_brain_version: string;
  required_contract_version: string;
  approval_id: string | null;
  local_path: string;
  observed_commit: string | null;
  project_brain_enabled: boolean;
  read_allowed: boolean;
  write_allowed: boolean;
  disabled_at: Date | null;
  allowed_agent_ids: string[];
  task_id: string | null;
};

const checksum = (value: Buffer) => createHash("sha256").update(new Uint8Array(value)).digest("hex");

async function git(repositoryPath: string, args: string[]) {
  const result = await runSafeProcess({
    executable: "/usr/bin/git",
    args,
    cwd: repositoryPath,
    allowedRoot: repositoryPath,
    timeoutMs: 5_000,
    maxOutputBytes: 100_000,
  });
  if (result.exitCode !== 0) throw new Error(`Repository validation failed: git ${args[0]}`);
  return result.stdout.trim();
}

async function validateLocalCheckout(row: OperationRow) {
  if (row.location_mode !== "server" || row.local_path.startsWith("mission-agent://"))
    throw new Error("unsupported_repository_location");
  const root = await realpath(process.env.CODEX_REPOSITORY_ROOT!);
  const checkout = await realpath(row.local_path);
  if (checkout !== root && !checkout.startsWith(`${root}${path.sep}`)) throw new Error("repository_path_outside_root");
  const head = await git(checkout, ["rev-parse", "HEAD"]);
  if (row.starting_sha && head !== row.starting_sha) throw new Error("repository_head_changed");
  const policy = projectBrainOperationPolicy(row.operation, (row.request.arguments as Record<string, unknown>) ?? {});
  if (policy.requiresCleanWorktree && (await git(checkout, ["status", "--porcelain"])))
    throw new Error("repository_worktree_dirty");
  return { checkout, head };
}

export async function executeProjectBrainOperation(input: {
  workspaceId: string;
  operationId: string;
  workerId: string;
  finalAttempt?: boolean;
}) {
  const row = (
    await getDatabasePool().query<OperationRow>(
      `SELECT p.*,r.local_path,r.observed_commit,r.project_brain_enabled,r.read_allowed,r.write_allowed,
        r.disabled_at,r.allowed_agent_ids,e.task_id
       FROM project_brain_operation_projections p
       JOIN repositories r ON r.workspace_id=p.workspace_id AND r.repository_id=p.repository_id
       LEFT JOIN execution_projections e ON e.workspace_id=p.workspace_id AND e.execution_id=p.execution_id
       WHERE p.workspace_id=$1 AND p.operation_id=$2`,
      [input.workspaceId, input.operationId],
    )
  ).rows[0];
  if (!row) throw new Error("Project Brain operation not found");
  if (["succeeded", "failed", "denied"].includes(row.status)) return { terminal: true, status: row.status };
  if (row.location_mode === "mission_agent") {
    try {
      await dispatchRemoteProjectBrainOperation(input);
      return { terminal: true, status: "dispatched" };
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      await appendProjectBrainOperationEvent({
        actor: { workspaceId: input.workspaceId, id: input.workerId, type: "agent" },
        operationId: input.operationId,
        commandId: stableUuid(
          `project-brain:${input.operationId}:remote-${input.finalAttempt ? "blocked" : "attempt-blocked"}`,
        ),
        event: {
          eventType: input.finalAttempt
            ? "project_brain.remote_operation_denied"
            : "project_brain.remote_operation_attempt_blocked",
          eventSchemaVersion: 1,
          payload: {
            repositoryId: row.repository_id,
            operation: row.operation,
            operationStatus: input.finalAttempt ? "denied" : "retrying",
            failureStage: "remote_dispatch",
            failureCause: cause.slice(0, 500),
            humanApprovalRequired: Boolean(
              projectBrainOperationPolicy(row.operation, (row.request.arguments as Record<string, unknown>) ?? {})
                .approvalType,
            ),
          },
        },
      });
      throw error;
    }
  }
  await appendProjectBrainOperationEvent({
    actor: { workspaceId: input.workspaceId, id: input.workerId, type: "agent" },
    operationId: input.operationId,
    commandId: stableUuid(`project-brain:${input.operationId}:start`),
    event: {
      eventType: "project_brain.operation_started",
      eventSchemaVersion: 1,
      payload: {
        repositoryId: row.repository_id,
        operation: row.operation,
        operationStatus: "started",
        workerId: input.workerId,
        startingSha: row.starting_sha,
      },
    },
  });
  try {
    const { checkout, head } = await validateLocalCheckout(row);
    const policy = projectBrainOperationPolicy(row.operation, (row.request.arguments as Record<string, unknown>) ?? {});
    if (row.disabled_at || !row.project_brain_enabled || !row.read_allowed)
      throw new Error("repository_authority_revoked");
    if (policy.requiredPermission === "write" && !row.write_allowed)
      throw new Error("repository_write_authority_revoked");
    if (row.agent_id) {
      if (!row.allowed_agent_ids.includes(row.agent_id)) throw new Error("agent_repository_authority_revoked");
      const resource = (
        await getDatabasePool().query<{ permissions: string[] }>(
          `SELECT permissions FROM agent_resource_permissions
           WHERE workspace_id=$1 AND agent_id=$2 AND resource_type='repository' AND resource_id=$3
             AND revoked_at IS NULL`,
          [input.workspaceId, row.agent_id, row.repository_id],
        )
      ).rows[0];
      if (!resource?.permissions.includes(policy.requiredPermission))
        throw new Error("agent_resource_authority_revoked");
    }
    const currentFingerprint = projectBrainRequestFingerprint({
      repositoryId: row.repository_id,
      missionId: row.mission_id,
      executionId: row.execution_id,
      agentId: row.agent_id,
      operation: row.operation,
      arguments: row.request.arguments ?? {},
      startingSha: row.starting_sha,
      locationMode: row.location_mode,
      expectedWriteScope: policy.artifactTypes,
      timeoutMs: Number(row.request.timeoutMs ?? 15_000),
      maxOutputBytes: Number(row.request.maxOutputBytes ?? 1_000_000),
      requiredProjectBrainVersion: row.required_project_brain_version,
      requiredContractVersion: row.required_contract_version,
      artifactVersioning: false,
    });
    if (currentFingerprint !== row.request_fingerprint) throw new Error("operation_request_fingerprint_changed");
    if (policy.approvalType) {
      if (!row.approval_id) throw new Error("approval_missing");
      const approval = (
        await getDatabasePool().query<{
          status: string;
          expires_at: Date | null;
          action_hash: string;
          approval_type: string;
          mission_id: string;
          execution_id: string | null;
          consumed_by_operation_id: string | null;
          consumed_action_hash: string | null;
        }>(
          `SELECT status,expires_at,action_hash,approval_type,mission_id,execution_id,
            consumed_by_operation_id,consumed_action_hash
           FROM approval_projections WHERE workspace_id=$1 AND approval_id=$2`,
          [input.workspaceId, row.approval_id],
        )
      ).rows[0];
      if (
        !approval ||
        !approvalPermitsProjectBrainOperation({
          status: approval.status,
          expiresAt: approval.expires_at,
          actionHash: approval.action_hash,
          expectedActionHash: currentFingerprint,
          approvalType: approval.approval_type,
          expectedApprovalType: policy.approvalType,
          missionId: approval.mission_id,
          expectedMissionId: row.mission_id,
          executionId: approval.execution_id,
          expectedExecutionId: row.execution_id,
          consumedByOperationId: approval.consumed_by_operation_id,
          consumedActionHash: approval.consumed_action_hash,
          operationId: input.operationId,
        })
      )
        throw new Error("approval_stale_or_mismatched");
      await consumeApproval({
        workspaceId: input.workspaceId,
        approvalId: row.approval_id,
        actorId: input.workerId,
        policyVersion: "project-brain-0.4.1",
        operationId: input.operationId,
        actionHash: currentFingerprint,
      });
    }
    const configuration = getProjectBrainConfiguration();
    if (!configuration.enabled) throw new Error("project_brain_not_configured");
    const client = new ProjectBrainClient({
      ...configuration,
      requiredVersion: row.required_project_brain_version,
      contractVersion: row.required_contract_version,
      timeoutMs: Number(row.request.timeoutMs ?? configuration.timeoutMs),
      maxOutputBytes: Number(row.request.maxOutputBytes ?? configuration.maxOutputBytes),
    });
    const result = await client.execute({
      workspaceId: input.workspaceId,
      repositoryId: row.repository_id,
      repositoryPath: checkout,
      operation: row.operation,
      request: (row.request.arguments as Record<string, unknown>) ?? {},
      missionId: row.mission_id ?? undefined,
      executionId: row.execution_id ?? undefined,
    });
    const resultData = result.envelope.data as Record<string, unknown>;
    const storedArtifacts: Array<Record<string, unknown>> = [];
    for (const artifact of result.envelope.artifacts) {
      const relativePath = String(artifact.path);
      const absolutePath = await realpath(path.join(checkout, relativePath));
      if (!absolutePath.startsWith(`${checkout}${path.sep}`)) throw new Error("artifact_path_outside_repository");
      const body = await readFile(absolutePath);
      if (checksum(body) !== artifact.sha256) throw new Error("artifact_checksum_mismatch");
      if (row.execution_id && row.mission_id && row.task_id) {
        const stored = await storeExecutionArtifact({
          workspaceId: input.workspaceId,
          missionId: row.mission_id,
          taskId: row.task_id,
          executionId: row.execution_id,
          kind: String(artifact.kind),
          mediaType: "text/markdown",
          body,
          maxBytes: Number(row.request.maxOutputBytes ?? 1_000_000),
          metadata: {
            repositoryPath: relativePath,
            schemaVersion: artifact.schema_version,
            contractVersion: result.envelope.contract_version,
            startingSha: head,
            projectBrainOperationId: input.operationId,
          },
        });
        storedArtifacts.push({ ...artifact, artifactId: stored.artifactId, byteSize: stored.byteSize });
      } else storedArtifacts.push(artifact);
    }
    const context = storedArtifacts.find((artifact) =>
      ["project_brain_context", "project_brain_context_pack", "context_pack"].includes(String(artifact.kind)),
    );
    const preview = (row.request.arguments as Record<string, unknown> | undefined)?.preview === true;
    const eventType =
      row.operation === "prepare_context"
        ? "project_brain.context_generated"
        : row.operation === "record_closure"
          ? "project_brain.closure_recorded"
          : row.operation === "propose_learning"
            ? "project_brain.learning_proposed"
            : row.operation === "evaluate_learning"
              ? "project_brain.learning_evaluated"
              : "project_brain.operation_succeeded";
    await appendProjectBrainOperationEvent({
      actor: { workspaceId: input.workspaceId, id: input.workerId, type: "agent" },
      operationId: input.operationId,
      commandId: stableUuid(`project-brain:${input.operationId}:success`),
      event: {
        eventType,
        eventSchemaVersion: 1,
        payload: {
          repositoryId: row.repository_id,
          operation: row.operation,
          operationStatus: "succeeded",
          endingSha: result.auditEvent.endingSha,
          warnings: result.envelope.warnings,
          result: {
            envelope: { ...result.envelope, artifacts: storedArtifacts },
            audit: result.auditEvent,
          },
          repositoryProjection: {
            availabilityState: "available",
            compatibilityState: "compatible",
            lastValidationStatus: row.operation === "validate_repository" ? result.envelope.status : undefined,
            lastValidatedSha: row.operation === "validate_repository" ? result.auditEvent.endingSha : undefined,
            projectBrainVersion: row.required_project_brain_version,
            contractVersion: result.envelope.contract_version,
            schemaVersions: Array.from(
              new Set(
                storedArtifacts
                  .map((artifact) => artifact.schema_version)
                  .filter((value): value is string => typeof value === "string"),
              ),
            ),
            currentStateFreshness: "current",
            proposedLearningCount: Number(resultData.proposed_count ?? 0),
            confirmedLearningCount: Number(resultData.confirmed_count ?? 0),
            staleCount: Number(resultData.stale_count ?? 0),
            unresolvedContradictionCount: Number(resultData.unresolved_contradiction_count ?? 0),
          },
          missionProjection:
            row.operation === "prepare_context" && preview && !context
              ? {
                  contextPreviewStatus: "available",
                  selectedSourceManifest:
                    (
                      (resultData.context_pack as Record<string, unknown> | undefined)?.selection as
                        Record<string, unknown> | undefined
                    )?.sources ?? [],
                  contextQuality:
                    (resultData.context_pack as Record<string, unknown> | undefined)?.context_quality ?? {},
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
                      contractVersion: result.envelope.contract_version,
                      startingSha: head,
                      contextBytes: context.byteSize,
                      selectedSourceManifest:
                        (
                          (resultData.context_pack as Record<string, unknown> | undefined)?.selection as
                            Record<string, unknown> | undefined
                        )?.sources ?? [],
                      contextQuality:
                        (resultData.context_pack as Record<string, unknown> | undefined)?.context_quality ?? {},
                    }
                : row.operation === "record_closure"
                  ? { closureStatus: "recorded" }
                  : row.operation === "propose_learning"
                    ? { learningProposalStatus: "proposed" }
                    : row.operation === "evaluate_learning"
                      ? { evaluationStatus: "evaluated" }
                      : undefined,
        },
      },
    });
    return { terminal: true, status: "succeeded" };
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    await appendProjectBrainOperationEvent({
      actor: { workspaceId: input.workspaceId, id: input.workerId, type: "agent" },
      operationId: input.operationId,
      commandId: stableUuid(`project-brain:${input.operationId}:failed`),
      event: {
        eventType: input.finalAttempt ? "project_brain.operation_failed" : "project_brain.operation_attempt_failed",
        eventSchemaVersion: 1,
        payload: {
          repositoryId: row.repository_id,
          operation: row.operation,
          operationStatus: input.finalAttempt ? "failed" : "retrying",
          failureStage: error instanceof ProjectBrainAdapterError ? "adapter" : "worker",
          failureCause: cause.slice(0, 500),
        },
      },
    });
    throw error;
  }
}
