import type { PoolClient } from "pg";
import {
  assertReplacementEligible,
  authorizationChecksum,
  createReplacementRecord,
  transitionReplacement,
  type ReplacementAuthorization,
  type ReplacementRecord,
  type ReplacementState,
} from "../integrations/mission-agent/replacement-bootstrap";

type StoredRow = {
  authorization_record: ReplacementAuthorization;
  authorization_checksum: string;
  state: ReplacementState;
  aggregate_version: number;
  execution_count: number;
  consumed_at: Date | null;
  revoked_at: Date | null;
  last_occurred_at: Date | null;
  last_event_checksum: string | null;
};

const toRecord = (row: StoredRow): ReplacementRecord => ({
  authorization: row.authorization_record,
  authorizationChecksum: row.authorization_checksum,
  state: row.state,
  version: row.aggregate_version,
  executionCount: row.execution_count,
  consumedAt: row.consumed_at?.toISOString() ?? null,
  revokedAt: row.revoked_at?.toISOString() ?? null,
  lastOccurredAt: row.last_occurred_at?.toISOString() ?? null,
  lastEventChecksum: row.last_event_checksum,
});

export async function prepareReplacementBootstrap(
  client: PoolClient,
  authorization: ReplacementAuthorization,
  context: {
    authenticatedOperator: string;
    authenticatedApprover: string;
    approvalEvidenceChecksum: string;
    now?: Date;
  },
): Promise<ReplacementRecord> {
  const now = context.now ?? new Date();
  if (
    context.authenticatedOperator !== authorization.operatorIdentity ||
    context.authenticatedApprover !== authorization.approvedBy ||
    !/^[a-f0-9]{64}$/.test(context.approvalEvidenceChecksum) ||
    !authorization.evidenceReferences.includes(`sha256:${context.approvalEvidenceChecksum}`)
  )
    throw new Error("Authenticated replacement approval does not match its durable evidence.");
  const record = createReplacementRecord(authorization, { now });
  const governedApproval = await client.query<{
    status: string;
    decided_by: string | null;
    action_hash: string;
    expires_at: Date | null;
  }>(
    `SELECT status,decided_by,action_hash,expires_at
       FROM approval_projections
      WHERE workspace_id=$1 AND approval_id=$2`,
    [authorization.workspaceId, authorization.approvalId],
  );
  const approval = governedApproval.rows[0];
  if (
    !approval ||
    approval.status !== "granted" ||
    approval.decided_by !== context.authenticatedApprover ||
    approval.action_hash !== record.authorizationChecksum ||
    (approval.expires_at !== null && approval.expires_at <= now)
  )
    throw new Error("Mission Control governed approval is absent, expired, or does not bind this authorization.");
  await client.query(
    `INSERT INTO mission_agent_replacement_bootstraps(
       workspace_id,authorization_id,approval_id,agent_id,protocol_version,authorization_record,authorization_checksum,
       state,aggregate_version,execution_count,expires_at,created_at,updated_at
     ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,0,$10,$11,$11)`,
    [
      authorization.workspaceId,
      authorization.authorizationId,
      authorization.approvalId,
      authorization.agentId,
      authorization.protocolVersion,
      JSON.stringify(authorization),
      record.authorizationChecksum,
      record.state,
      record.version,
      authorization.expiresAt,
      now.toISOString(),
    ],
  );
  return record;
}

export async function loadReplacementBootstrap(
  client: PoolClient,
  workspaceId: string,
  authorizationId: string,
): Promise<ReplacementRecord | null> {
  const result = await client.query<StoredRow>(
    `SELECT authorization_record,authorization_checksum,state,aggregate_version,execution_count,
            consumed_at,revoked_at,last_occurred_at,last_event_checksum
       FROM mission_agent_replacement_bootstraps
      WHERE workspace_id=$1 AND authorization_id=$2`,
    [workspaceId, authorizationId],
  );
  return result.rows[0] ? toRecord(result.rows[0]) : null;
}

export async function transitionReplacementBootstrap(
  client: PoolClient,
  input: {
    workspaceId: string;
    authorizationId: string;
    expectedVersion: number;
    to: ReplacementState;
    eventId: string;
    evidenceChecksum: string;
    operatorIdentity: string;
    executionContext?: {
      agentId: string;
      hostIdentity: string;
      currentVersion: string;
      currentArtifactSha256: string;
      repositoryId: string;
      repositoryFingerprint: string;
      healthy: boolean;
      drained: boolean;
      activeMission: boolean;
      activeLease: boolean;
    };
  },
): Promise<ReplacementRecord> {
  await client.query("BEGIN");
  try {
    const selected = await client.query<StoredRow>(
      `SELECT authorization_record,authorization_checksum,state,aggregate_version,execution_count,
              consumed_at,revoked_at,last_occurred_at,last_event_checksum
         FROM mission_agent_replacement_bootstraps
        WHERE workspace_id=$1 AND authorization_id=$2
        FOR UPDATE`,
      [input.workspaceId, input.authorizationId],
    );
    if (!selected.rows[0]) throw new Error("Replacement authorization is unavailable.");
    const current = toRecord(selected.rows[0]);
    const databaseClock = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
    const authoritativeNow = databaseClock.rows[0]?.now;
    if (!authoritativeNow) throw new Error("Authoritative database clock is unavailable.");
    const occurredAt = authoritativeNow.toISOString();
    if (input.to === "replacing") {
      if (!input.executionContext) throw new Error("Atomic replacement execution context is required.");
      const governedApproval = await client.query<{
        status: string;
        decided_by: string | null;
        action_hash: string;
        expires_at: Date | null;
      }>(
        `SELECT status,decided_by,action_hash,expires_at
           FROM approval_projections
          WHERE workspace_id=$1 AND approval_id=$2
          FOR UPDATE`,
        [input.workspaceId, current.authorization.approvalId],
      );
      const approval = governedApproval.rows[0];
      if (
        !approval ||
        approval.status !== "granted" ||
        approval.decided_by !== current.authorization.approvedBy ||
        approval.action_hash !== current.authorizationChecksum ||
        (approval.expires_at !== null && approval.expires_at <= authoritativeNow)
      )
        throw new Error("Governed replacement approval is no longer active at one-shot consumption.");
      const duplicates = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM mission_agent_replacement_bootstraps
          WHERE workspace_id=$1 AND agent_id=$2
            AND state IN ('prepared','approved','draining','verified','staged','replacing','starting','connected','accepted')`,
        [input.workspaceId, input.executionContext.agentId],
      );
      assertReplacementEligible({
        record: current,
        workspaceId: input.workspaceId,
        ...input.executionContext,
        now: authoritativeNow,
        duplicateActiveAuthorizations: Number(duplicates.rows[0]?.count ?? 0),
      });
    }
    const result = transitionReplacement(current, { ...input, occurredAt });
    const updated = await client.query(
      `UPDATE mission_agent_replacement_bootstraps
          SET state=$4,aggregate_version=$5,execution_count=$6,consumed_at=$7,revoked_at=$8,
              last_occurred_at=$9,last_event_checksum=$10,updated_at=$11
        WHERE workspace_id=$1 AND authorization_id=$2 AND aggregate_version=$3`,
      [
        input.workspaceId,
        input.authorizationId,
        input.expectedVersion,
        result.record.state,
        result.record.version,
        result.record.executionCount,
        result.record.consumedAt,
        result.record.revokedAt,
        result.record.lastOccurredAt,
        result.record.lastEventChecksum,
        occurredAt,
      ],
    );
    if (updated.rowCount !== 1) throw new Error("Replacement compare-and-set failed.");
    await client.query(
      `INSERT INTO mission_agent_replacement_events(
         workspace_id,authorization_id,event_id,from_state,to_state,aggregate_version,
         evidence_checksum,previous_event_checksum,event_checksum,occurred_at,operator_identity
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        input.workspaceId,
        input.authorizationId,
        input.eventId,
        result.event.from,
        result.event.to,
        result.event.version,
        result.event.evidenceChecksum,
        result.event.previousEventChecksum,
        result.event.checksum,
        result.event.occurredAt,
        input.operatorIdentity,
      ],
    );
    await client.query("COMMIT");
    return result.record;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function decideReplacementBootstrap(
  client: PoolClient,
  input: {
    workspaceId: string;
    authorizationId: string;
    agentId: string;
    hostIdentity: string;
    currentVersion: string;
    currentArtifactSha256: string;
    repositoryId: string;
    repositoryFingerprint: string;
    healthy: boolean;
    drained: boolean;
    activeMission: boolean;
    activeLease: boolean;
    now?: Date;
  },
): Promise<{ eligible: true; authorizationChecksum: string }> {
  const record = await loadReplacementBootstrap(client, input.workspaceId, input.authorizationId);
  if (!record) throw new Error("Replacement authorization is unavailable.");
  const duplicates = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM mission_agent_replacement_bootstraps
      WHERE workspace_id=$1 AND agent_id=$2
        AND state IN ('prepared','approved','draining','verified','staged','replacing','starting','connected','accepted')`,
    [input.workspaceId, input.agentId],
  );
  assertReplacementEligible({
    record,
    ...input,
    duplicateActiveAuthorizations: Number(duplicates.rows[0]?.count ?? 0),
  });
  if (record.authorizationChecksum !== authorizationChecksum(record.authorization))
    throw new Error("Replacement authorization checksum mismatch.");
  return { eligible: true, authorizationChecksum: record.authorizationChecksum };
}
