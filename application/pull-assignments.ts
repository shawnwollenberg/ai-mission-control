import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { getDatabasePool, withTransaction } from "@/lib/database";
import { NotFoundError, ValidationFailedError } from "@/lib/application-errors";
import { evaluateAgentEligibility } from "@/application/agent-eligibility";
import type { AgentOperation, ModelCapabilityRole } from "@/domain/agent-provider";
import { stableUuid } from "@/lib/stable-id";

const terminal = ["succeeded", "failed", "timed_out", "cancelled"];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

const consensusOperation: Record<string, AgentOperation> = {
  prepare_context: "prepare_project_brain_context",
  proposal: "generate_structured_plan",
  critique: "critique_plan",
  revision: "revise_plan",
  canonicalize: "generate_structured_plan",
  verdict: "review_canonical_plan",
};

type AssignmentBinding = {
  participantAssignmentId: string;
  agentId: string;
  providerId: string;
  modelId: string;
  capabilityAttestationId: string;
  capabilityAttestationHash: string;
  permissionProfileHash: string;
  providerRuntimeRequirementsId: string;
  providerRuntimeRequirementsHash: string;
};

type PullAssignmentAuthorityRow = {
  workspace_id: string;
  mission_id: string;
  task_id: string;
  agent_id: string;
  execution_id: string;
  attempt: number;
  execution_status: string;
  cancellation_requested_at: Date | null;
  lease_owner: string | null;
  lease_token_hash: string | null;
  lease_expires_at: Date | null;
  fencing_token: number;
  payload: {
    missionType?: string;
    allowedCapabilities?: string[];
    consensus?: {
      operation?: string;
      participantRole?: string;
      repositoryBaseCommit?: string;
      assignmentBinding?: AssignmentBinding;
    };
    approvedPlan?: {
      hash?: string;
      repositorySnapshot?: string;
      repositoryAuthorityHash?: string;
      contextPackHash?: string;
      executorAssignment?: AssignmentBinding;
      approvalReceipt?: { repositoryBaseCommit?: string };
    };
  };
};

async function revalidateAssignmentAuthority(
  row: PullAssignmentAuthorityRow,
  database: Pick<PoolClient, "query"> = getDatabasePool(),
) {
  const consensus = row.payload?.consensus;
  const executor = row.payload?.approvedPlan?.executorAssignment;
  if (!consensus && !executor) return row;
  if (terminal.includes(row.execution_status))
    throw new ValidationFailedError(`Execution is terminal (${row.execution_status}); assignment authority is revoked`);
  const binding = executor ?? consensus?.assignmentBinding;
  if (!binding)
    throw new ValidationFailedError("Assignment is missing its immutable provider/model capability binding");
  const operation = executor ? "implement_change" : consensusOperation[String(consensus?.operation ?? "")];
  const modelRole: ModelCapabilityRole = executor
    ? "executor"
    : consensus?.participantRole === "synthesizer"
      ? "synthesizer"
      : consensus?.participantRole === "implementation_reviewer"
        ? "implementation_reviewer"
        : "planner";
  if (!operation) throw new ValidationFailedError("Assignment operation is not supported");
  const authority = (
    await database.query<{
      repository_id: string;
      parent_consensus_mission_id: string | null;
      observed_commit: string | null;
      read_allowed: boolean;
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
      repository_authority_hash: string | null;
      bound_repository_authority_hash: string | null;
      disabled_at: Date | null;
      allowed_agent_ids: string[];
      participant_assignment_id: string;
      agent_id: string;
      provider_id: string;
      model_id: string;
      capability_attestation_id: string;
      capability_attestation_hash: string;
      permission_profile_hash: string;
      provider_runtime_requirements_id: string;
      provider_runtime_requirements_hash: string;
      status: string;
    }>(
      `SELECT m.repository_id,m.parent_consensus_mission_id,r.observed_commit,r.read_allowed,r.write_allowed,r.commit_allowed,
         r.isolated_worktree_write_allowed,r.mission_agent_local_commit_allowed,r.provider_direct_commit_allowed,
         r.push_allowed,r.pull_request_allowed,r.merge_allowed,r.publication_allowed,r.deployment_allowed,r.infrastructure_mutation_allowed,
         r.repository_authority_hash,c.repository_authority_hash bound_repository_authority_hash,
         r.disabled_at,r.allowed_agent_ids,p.participant_assignment_id,p.agent_id,p.provider_id,p.model_id,
         p.capability_attestation_id,p.capability_attestation_hash,p.permission_profile_hash,
         p.provider_runtime_requirements_id,p.provider_runtime_requirements_hash,p.status
       FROM task_projections t JOIN mission_projections m
         ON m.workspace_id=t.workspace_id AND m.mission_id=t.mission_id
       JOIN repositories r ON r.workspace_id=m.workspace_id AND r.repository_id=m.repository_id
       JOIN consensus_plan_projections c ON c.workspace_id=m.workspace_id
         AND c.mission_id=COALESCE(m.parent_consensus_mission_id,m.mission_id)
       JOIN consensus_participant_assignments p ON p.workspace_id=t.workspace_id AND (
         (m.mission_type='consensus_plan' AND p.mission_id=m.mission_id
           AND p.participant_assignment_id=NULLIF(t.approval_requirements->>'participantAssignmentId','')::uuid)
         OR
         (m.parent_consensus_mission_id IS NOT NULL AND p.mission_id=m.parent_consensus_mission_id AND p.role='executor')
       )
       WHERE t.workspace_id=$1 AND t.task_id=$2`,
      [row.workspace_id, row.task_id],
    )
  ).rows[0];
  if (
    !authority ||
    authority.status !== "active" ||
    authority.disabled_at ||
    !authority.allowed_agent_ids.includes(row.agent_id) ||
    authority.participant_assignment_id !== binding.participantAssignmentId ||
    authority.agent_id !== row.agent_id ||
    authority.provider_id !== binding.providerId ||
    authority.model_id !== binding.modelId ||
    authority.capability_attestation_id !== binding.capabilityAttestationId ||
    authority.capability_attestation_hash !== binding.capabilityAttestationHash ||
    authority.permission_profile_hash !== binding.permissionProfileHash ||
    authority.provider_runtime_requirements_id !== binding.providerRuntimeRequirementsId ||
    authority.provider_runtime_requirements_hash !== binding.providerRuntimeRequirementsHash
  )
    throw new ValidationFailedError("Assignment authority was revoked or no longer matches its immutable binding");
  const write = Boolean(executor);
  if (
    !authority.repository_authority_hash ||
    authority.repository_authority_hash !== authority.bound_repository_authority_hash
  )
    throw new ValidationFailedError("Repository authority binding changed after readiness");
  if (!write && !authority.read_allowed) throw new ValidationFailedError("Repository inspection authority was revoked");
  if (
    write &&
    (authority.write_allowed ||
      authority.commit_allowed ||
      !authority.isolated_worktree_write_allowed ||
      !authority.mission_agent_local_commit_allowed ||
      authority.provider_direct_commit_allowed ||
      authority.push_allowed ||
      authority.pull_request_allowed ||
      authority.merge_allowed ||
      authority.publication_allowed ||
      authority.deployment_allowed ||
      authority.infrastructure_mutation_allowed)
  )
    throw new ValidationFailedError("Repository isolated-worktree or local-commit authority was revoked or broadened");
  const expectedCommit = executor
    ? row.payload.approvedPlan?.approvalReceipt?.repositoryBaseCommit
    : row.payload.consensus?.repositoryBaseCommit;
  if (expectedCommit && authority.observed_commit !== expectedCommit)
    throw new ValidationFailedError("Repository state changed after assignment authority was bound");
  const eligibility = await evaluateAgentEligibility({
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    domain: "software_delivery",
    requiredCapabilities: row.payload?.allowedCapabilities ?? [],
    requiredResources: [
      {
        resourceType: "repository",
        resourceId: authority.repository_id,
        permission: write ? "isolated_worktree_write" : "read",
      },
    ],
    protocolVersion: "1.0",
    requiredMissionRole: executor ? "executor" : consensus?.operation === "verdict" ? "reviewer" : "planner",
    requiredOperation: operation,
    requiredModel: binding.modelId,
    requiredModelRole: modelRole,
    requireStructuredOutput: true,
    requireProjectBrainContext: !executor,
    requireRepositoryMutation: write,
    requireVerifiedMissionAgentArtifact: true,
    excludeExecutionId: row.execution_id,
    database,
  });
  if (
    !eligibility.eligible ||
    eligibility.providerId !== binding.providerId ||
    eligibility.capabilityAttestationId !== binding.capabilityAttestationId ||
    eligibility.capabilityAttestationHash !== binding.capabilityAttestationHash ||
    eligibility.providerRuntimeProfile?.profileId !== binding.providerRuntimeRequirementsId ||
    eligibility.providerRuntimeProfile?.runtimeBindingHash !== binding.providerRuntimeRequirementsHash
  )
    throw new ValidationFailedError("Assignment eligibility was revoked", { reasons: eligibility.reasons });
  return row;
}

export type PullCredential = { workspace_id: string; agent_id: string; credential_id: string };

export async function createPullAssignment(
  client: PoolClient,
  input: {
    workspaceId: string;
    executionId: string;
    missionId: string;
    taskId: string;
    agentId: string;
    attempt: number;
    payload: Record<string, unknown>;
  },
) {
  const assignmentId = randomUUID();
  await client.query(
    `INSERT INTO pull_assignments(workspace_id,assignment_id,execution_id,mission_id,task_id,agent_id,attempt,status,payload)
     VALUES($1,$2,$3,$4,$5,$6,$7,'available',$8)
     ON CONFLICT(workspace_id,execution_id) DO NOTHING`,
    [
      input.workspaceId,
      assignmentId,
      input.executionId,
      input.missionId,
      input.taskId,
      input.agentId,
      input.attempt,
      JSON.stringify(input.payload),
    ],
  );
  return assignmentId;
}

export async function claimNextAssignment(input: {
  credential: PullCredential;
  leaseOwner: string;
  leaseSeconds?: number;
  assignmentId?: string;
}) {
  if (!input.leaseOwner || input.leaseOwner.length > 120) throw new ValidationFailedError("Invalid lease owner");
  const leaseSeconds = Math.min(Math.max(input.leaseSeconds ?? 60, 30), 120);
  return withTransaction(async (client) => {
    const agent = (
      await client.query<{
        status: string;
        delivery_mode: string;
        pull_ready_at: Date | null;
        last_heartbeat_at: Date | null;
        pause_new_executions: boolean;
        pause_remote_assignments: boolean;
      }>(
        `SELECT a.status,a.delivery_mode,a.pull_ready_at,a.last_heartbeat_at,
          COALESCE(c.pause_new_executions,false) pause_new_executions,
          COALESCE(c.pause_remote_assignments,false) pause_remote_assignments
         FROM agents a LEFT JOIN workspace_emergency_controls c ON c.workspace_id=a.workspace_id
         WHERE a.workspace_id=$1 AND a.agent_id=$2 FOR UPDATE OF a`,
        [input.credential.workspace_id, input.credential.agent_id],
      )
    ).rows[0];
    if (
      !agent ||
      agent.status === "disabled" ||
      agent.delivery_mode !== "pull" ||
      !agent.pull_ready_at ||
      !agent.last_heartbeat_at ||
      Date.now() - new Date(agent.pull_ready_at).getTime() > 5 * 60_000 ||
      Date.now() - new Date(agent.last_heartbeat_at).getTime() > 5 * 60_000 ||
      agent.pause_new_executions ||
      agent.pause_remote_assignments
    )
      return undefined;

    if (input.assignmentId) {
      const known = (
        await client.query<{
          agent_id: string;
          assignment_status: string;
          execution_status: string;
          cancellation_requested_at: Date | null;
        }>(
          `SELECT p.agent_id,p.status assignment_status,e.status execution_status,e.cancellation_requested_at
           FROM pull_assignments p JOIN execution_projections e
             ON e.workspace_id=p.workspace_id AND e.execution_id=p.execution_id
           WHERE p.workspace_id=$1 AND p.assignment_id=$2 FOR UPDATE OF p`,
          [input.credential.workspace_id, input.assignmentId],
        )
      ).rows[0];
      if (!known || known.agent_id !== input.credential.agent_id)
        throw new ValidationFailedError("Known assignment claim binding does not match", {
          reason_code: "ASSIGNMENT_BINDING_MISMATCH",
        });
      if (
        known.cancellation_requested_at ||
        known.execution_status === "cancelled" ||
        !["available", "leased", "acknowledged"].includes(known.assignment_status)
      )
        throw new ValidationFailedError("Known cancelled assignment cannot be claimed", {
          reason_code: "CANCELLED_ASSIGNMENT_CLAIM_REJECTED",
        });
    }

    const expired = await client.query<{ assignment_id: string }>(
      `SELECT p.assignment_id FROM pull_assignments p JOIN execution_projections e
         ON e.workspace_id=p.workspace_id AND e.execution_id=p.execution_id
       WHERE p.workspace_id=$1 AND p.agent_id=$2 AND p.status IN('leased','acknowledged')
         AND p.lease_expires_at<=now() AND e.status NOT IN ('succeeded','failed','timed_out','cancelled')
       LIMIT 100`,
      [input.credential.workspace_id, input.credential.agent_id],
    );
    for (const row of expired.rows) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${input.credential.workspace_id}:${row.assignment_id}`,
      ]);
      await client.query(
        `UPDATE pull_assignments p SET status='available',lease_owner=NULL,lease_token_hash=NULL,
           lease_expires_at=NULL,updated_at=now()
         FROM execution_projections e WHERE p.workspace_id=$1 AND p.assignment_id=$2
           AND p.execution_id=e.execution_id AND p.workspace_id=e.workspace_id
           AND p.status IN('leased','acknowledged') AND p.lease_expires_at<=now()
           AND e.status NOT IN ('succeeded','failed','timed_out','cancelled')`,
        [input.credential.workspace_id, row.assignment_id],
      );
    }
    const active = (
      await client.query(
        `SELECT p.* FROM pull_assignments p JOIN execution_projections e ON e.workspace_id=p.workspace_id AND e.execution_id=p.execution_id
         WHERE p.workspace_id=$1 AND p.agent_id=$2 AND p.lease_owner=$3 AND p.status IN('leased','acknowledged')
           AND p.lease_expires_at>now() AND e.status NOT IN ('succeeded','failed','timed_out','cancelled')
         ORDER BY p.claimed_at LIMIT 1 FOR UPDATE OF p`,
        [input.credential.workspace_id, input.credential.agent_id, input.leaseOwner],
      )
    ).rows[0];
    if (active) {
      await revalidateAssignmentAuthority(active, client);
      // A bearer lease is transport-only and cannot be recovered from a durable
      // receipt. Do not return an authority-shaped assignment without its token;
      // the original in-memory holder may continue until expiry, after which a
      // fresh pull can claim a newly fenced lease.
      return undefined;
    }

    const assignment = (
      await client.query(
        `SELECT p.*,e.status execution_status,t.status task_status FROM pull_assignments p JOIN execution_projections e ON e.workspace_id=p.workspace_id AND e.execution_id=p.execution_id
         JOIN task_projections t ON t.workspace_id=p.workspace_id AND t.task_id=p.task_id
         JOIN agents a ON a.workspace_id=p.workspace_id AND a.agent_id=p.agent_id
         JOIN repositories r ON r.workspace_id=p.workspace_id
           AND r.repository_id=e.repository_id
         WHERE p.workspace_id=$1 AND p.agent_id=$2 AND p.status='available' AND e.agent_id=$2
           AND ($3::uuid IS NULL OR p.assignment_id=$3)
           AND e.status IN('requested','accepted','preparing','running')
           AND e.cancellation_requested_at IS NULL
           AND t.status IN('assigned','running') AND a.status='active' AND a.capabilities @> t.required_capabilities
           AND r.identity_migration_status IN('not_required','completed') AND r.disabled_at IS NULL
           AND r.allowed_agent_ids ? $2::text
           AND (
             NOT EXISTS (
               SELECT 1 FROM jsonb_array_elements(t.required_resources) resource
               WHERE resource->>'resourceType'='repository'
                 AND resource->>'permission' IN('write','isolated_worktree_write')
             ) OR (
               (p.payload ? 'approvedPlan' AND EXISTS (
                   SELECT 1 FROM jsonb_array_elements(t.required_resources) resource
                   WHERE resource->>'resourceType'='repository'
                     AND resource->>'permission'='isolated_worktree_write'
                 ) AND NOT r.write_allowed AND NOT r.commit_allowed AND r.isolated_worktree_write_allowed
                 AND r.mission_agent_local_commit_allowed AND NOT r.provider_direct_commit_allowed
                 AND NOT r.push_allowed AND NOT r.pull_request_allowed AND NOT r.merge_allowed AND NOT r.publication_allowed
                 AND NOT r.deployment_allowed AND NOT r.infrastructure_mutation_allowed)
               OR (NOT (p.payload ? 'approvedPlan') AND EXISTS (
                   SELECT 1 FROM jsonb_array_elements(t.required_resources) resource
                   WHERE resource->>'resourceType'='repository' AND resource->>'permission'='write'
                 ) AND r.write_allowed)
             )
           )
           AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(t.required_resources) resource
             WHERE NOT EXISTS (
               SELECT 1 FROM agent_resource_permissions permission
               WHERE permission.workspace_id=p.workspace_id AND permission.agent_id=p.agent_id
                 AND permission.resource_type=resource->>'resourceType' AND permission.resource_id=resource->>'resourceId'
                 AND permission.revoked_at IS NULL AND permission.permissions ? (resource->>'permission')
             )
           )
         ORDER BY p.created_at LIMIT 1`,
        [input.credential.workspace_id, input.credential.agent_id, input.assignmentId ?? null],
      )
    ).rows[0];
    if (!assignment) return undefined;
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${input.credential.workspace_id}:${assignment.assignment_id}`,
    ]);
    const current = await client.query<{ status: string }>(
      `SELECT status FROM pull_assignments WHERE workspace_id=$1 AND assignment_id=$2 FOR UPDATE`,
      [input.credential.workspace_id, assignment.assignment_id],
    );
    if (current.rows[0]?.status !== "available") return undefined;
    try {
      await revalidateAssignmentAuthority(assignment, client);
    } catch (error) {
      if (!assignment.payload?.consensus && !assignment.payload?.approvedPlan) throw error;
      if (
        !(error instanceof ValidationFailedError) ||
        !/Repository authority binding changed|Assignment authority was revoked or no longer matches its immutable binding|Repository state changed|Execution is terminal/.test(
          error.message,
        )
      )
        throw error;
      await client.query(
        `UPDATE pull_assignments SET status='released',lease_owner=NULL,lease_token_hash=NULL,
           lease_expires_at=NULL,fencing_token=fencing_token+1,updated_at=now()
         WHERE workspace_id=$1 AND assignment_id=$2 AND status='available'`,
        [input.credential.workspace_id, assignment.assignment_id],
      );
      return undefined;
    }
    const resumed = assignment.execution_status !== "requested";
    const leaseToken = `mc_lease_${randomBytes(32).toString("base64url")}`;
    const leaseTokenFingerprint = hash(leaseToken);
    const nextFencingToken = Number(assignment.fencing_token) + 1;
    const leaseReceiptId = stableUuid(
      `lease-receipt:${input.credential.workspace_id}:${input.credential.agent_id}:${assignment.assignment_id}:execution_assignment:${nextFencingToken}:${leaseTokenFingerprint}`,
    );
    const leased = (
      await client.query(
        `UPDATE pull_assignments SET status='leased',lease_owner=$3,lease_token_hash=$4,
          lease_receipt_id=$6,lease_token_fingerprint=$7,fencing_token=fencing_token+1,claimed_at=COALESCE(claimed_at,now()),
          lease_expires_at=now()+($5*interval '1 second'),last_renewed_at=now(),updated_at=now()
         WHERE workspace_id=$1 AND assignment_id=$2 AND status='available' RETURNING *`,
        [
          input.credential.workspace_id,
          assignment.assignment_id,
          input.leaseOwner,
          hash(leaseToken),
          leaseSeconds,
          leaseReceiptId,
          leaseTokenFingerprint,
        ],
      )
    ).rows[0];
    return { assignment: leased, leaseToken, resumed };
  });
}

async function requireLease(
  input: {
    credential: PullCredential;
    assignmentId: string;
    leaseOwner: string;
    leaseToken: string;
    fencingToken?: number;
  },
  database: Pick<PoolClient, "query"> = getDatabasePool(),
) {
  const row = (
    await database.query<PullAssignmentAuthorityRow>(
      `SELECT p.*,e.status execution_status,e.cancellation_requested_at FROM pull_assignments p
       JOIN execution_projections e ON e.workspace_id=p.workspace_id AND e.execution_id=p.execution_id
       WHERE p.workspace_id=$1 AND p.assignment_id=$2 AND p.agent_id=$3`,
      [input.credential.workspace_id, input.assignmentId, input.credential.agent_id],
    )
  ).rows[0];
  if (!row) throw new NotFoundError("Assignment");
  assertAssignmentLeaseAuthority(input, row);
  return revalidateAssignmentAuthority(row, database);
}

export function assertAssignmentLeaseAuthority(
  input: { leaseOwner: string; leaseToken: string; fencingToken?: number },
  row: Pick<
    PullAssignmentAuthorityRow,
    "lease_owner" | "lease_token_hash" | "lease_expires_at" | "fencing_token" | "payload"
  >,
  now = Date.now(),
) {
  if (
    row.lease_owner !== input.leaseOwner ||
    row.lease_token_hash !== hash(input.leaseToken) ||
    !row.lease_expires_at ||
    new Date(row.lease_expires_at).getTime() <= now
  )
    throw new ValidationFailedError("Assignment lease is invalid or expired", {
      reason_code: "ASSIGNMENT_LEASE_LOST",
    });
  if (
    ["consensus_plan", "repository_change"].includes(String(row.payload?.missionType ?? "")) &&
    (!Number.isSafeInteger(input.fencingToken) || Number(input.fencingToken) !== Number(row.fencing_token))
  )
    throw new ValidationFailedError("Assignment fencing token is stale or missing");
}

export async function validateExecutionLease(input: Parameters<typeof requireLease>[0] & { executionId: string }) {
  const row = await requireLease(input);
  if (row.execution_id !== input.executionId) throw new ValidationFailedError("Lease is not valid for this execution");
  return row;
}

export async function acquireExecutionLeaseFence(
  input: Parameters<typeof validateExecutionLease>[0],
): Promise<() => Promise<void>> {
  const client = await getDatabasePool().connect();
  const key = `${input.credential.workspace_id}:${input.assignmentId}`;
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [key]);
    await validateExecutionLease(input);
  } catch (error) {
    await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]).catch(() => undefined);
    client.release();
    throw error;
  }
  return async () => {
    await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]).catch(() => undefined);
    client.release();
  };
}

export async function acknowledgeAssignment(
  input: Parameters<typeof requireLease>[0] & {
    acknowledgedPlanHash?: string;
    acknowledgedAgentId?: string;
    acknowledgedProviderId?: string;
    acknowledgedModelId?: string;
    acknowledgedRepositorySnapshot?: string;
    acknowledgedRepositoryAuthorityHash?: string;
    acknowledgedContextPackHash?: string;
    acknowledgedPermissionProfileHash?: string;
  },
) {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${input.credential.workspace_id}:${input.assignmentId}`,
    ]);
    const row = await requireLease(input, client);
    if (terminal.includes(row.execution_status)) throw new ValidationFailedError("Execution is already terminal");
    const approvedPlanHash = row.payload?.approvedPlan?.hash;
    if (approvedPlanHash && input.acknowledgedPlanHash !== approvedPlanHash)
      throw new ValidationFailedError("Executor must acknowledge the exact approved canonical plan hash");
    const approvedPlan = row.payload?.approvedPlan;
    const executor = approvedPlan?.executorAssignment;
    if (
      executor &&
      (input.acknowledgedAgentId !== executor.agentId ||
        input.acknowledgedProviderId !== executor.providerId ||
        input.acknowledgedModelId !== executor.modelId ||
        input.acknowledgedRepositorySnapshot !== approvedPlan?.repositorySnapshot ||
        input.acknowledgedRepositoryAuthorityHash !== approvedPlan?.repositoryAuthorityHash ||
        input.acknowledgedContextPackHash !== approvedPlan?.contextPackHash ||
        input.acknowledgedPermissionProfileHash !== executor.permissionProfileHash)
    )
      throw new ValidationFailedError(
        "Executor must acknowledge the exact agent, provider, model, snapshot, context, and permission binding",
      );
    const updated = await client.query(
      `UPDATE pull_assignments SET status='acknowledged',updated_at=now()
       WHERE workspace_id=$1 AND assignment_id=$2 AND status IN('leased','acknowledged') RETURNING assignment_id`,
      [input.credential.workspace_id, input.assignmentId],
    );
    if (!updated.rowCount) throw new ValidationFailedError("Assignment authority was fenced before acknowledgement");
    return row;
  });
}

export async function renewAssignmentLease(input: Parameters<typeof requireLease>[0] & { leaseSeconds?: number }) {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${input.credential.workspace_id}:${input.assignmentId}`,
    ]);
    const row = await requireLease(input, client);
    if (terminal.includes(row.execution_status)) throw new ValidationFailedError("Execution is already terminal");
    const seconds = Math.min(Math.max(input.leaseSeconds ?? 60, 30), 120);
    const renewed = (
      await client.query<{ lease_expires_at: Date; fencing_token: number }>(
        `UPDATE pull_assignments SET lease_expires_at=now()+($3*interval '1 second'),last_renewed_at=now(),updated_at=now()
       WHERE workspace_id=$1 AND assignment_id=$2 AND status IN('leased','acknowledged')
       RETURNING lease_expires_at,fencing_token`,
        [input.credential.workspace_id, input.assignmentId, seconds],
      )
    ).rows[0];
    if (!renewed) throw new ValidationFailedError("Assignment authority was fenced before lease renewal");
    return { ...row, lease_expires_at: renewed.lease_expires_at, fencing_token: renewed.fencing_token };
  });
}

export async function checkAssignmentCancellation(input: Parameters<typeof requireLease>[0]) {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${input.credential.workspace_id}:${input.assignmentId}`,
    ]);
    const row = await requireLease(input, client);
    return { cancellationRequested: Boolean(row.cancellation_requested_at), executionStatus: row.execution_status };
  });
}

export async function releaseAssignment(input: Parameters<typeof requireLease>[0]) {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${input.credential.workspace_id}:${input.assignmentId}`,
    ]);
    const row = await requireLease(input, client);
    if (!terminal.includes(row.execution_status))
      await client.query(
        `UPDATE pull_assignments SET status='available',lease_owner=NULL,lease_token_hash=NULL,lease_expires_at=NULL,updated_at=now()
       WHERE workspace_id=$1 AND assignment_id=$2 AND status IN('leased','acknowledged')`,
        [input.credential.workspace_id, input.assignmentId],
      );
    return row;
  });
}

export async function completePullAssignment(workspaceId: string, executionId: string) {
  await getDatabasePool().query(
    "UPDATE pull_assignments SET status='completed',lease_token_hash=NULL,lease_expires_at=NULL,updated_at=now() WHERE workspace_id=$1 AND execution_id=$2",
    [workspaceId, executionId],
  );
}
