import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { getDatabasePool, withTransaction } from "../../lib/database";
import type { WorkerDispatch, WorkerHealth, WorkerResult, WorkerStatus } from "./protocol";
import { sha256 } from "./protocol";
import { failedDispatchRecovery, type FailedDispatchRecovery } from "./recovery";

export type WorkerPresence = Omit<WorkerHealth, "schema" | "status"> & {
  status: WorkerStatus;
  lastSeenAt: string;
};

export interface WorkerCoordinationStore {
  heartbeat(health: WorkerHealth): Promise<void>;
  get(dispatchId: string): Promise<WorkerDispatch | undefined>;
  enqueue(input: Omit<WorkerDispatch, "schema" | "dispatchId">): Promise<WorkerDispatch>;
  recoverFailed(dispatchId: string): Promise<FailedDispatchRecovery | undefined>;
  claim(health: WorkerHealth, duplicateWindowMs: number): Promise<WorkerDispatch | undefined>;
  complete(health: WorkerHealth, result: WorkerResult): Promise<{ dispatch: WorkerDispatch; duplicate: boolean }>;
  markCommitted(dispatchId: string, githubRevision: number): Promise<void>;
  fail(health: WorkerHealth, dispatchId: string | undefined, code: string): Promise<void>;
  presence(offlineAfterMs: number): Promise<WorkerPresence | undefined>;
  list(): Promise<
    Array<{
      dispatch: WorkerDispatch;
      status: string;
      resultingGitHubRevision?: number;
      providerThreadId?: string;
      failureCode?: string;
    }>
  >;
}

type DispatchRow = {
  dispatch_id: string;
  project_id: string;
  mission_id: string;
  issue_number: number;
  mission_revision: number;
  actor: "ARCHITECT" | "ENGINEER";
  adapter: string;
  idempotency_key: string;
  mission_digest: string;
  packet: WorkerDispatch["packet"];
  status: string;
  resulting_github_revision: number | null;
  worker_id: string | null;
  worker_session_id: string | null;
  result_sha256: string | null;
  provider_thread_id: string | null;
  failure_code: string | null;
};
type PresenceRow = {
  worker_id: string;
  display_name: string;
  session_id: string;
  status: WorkerStatus;
  current_dispatch_id: string | null;
  architect_available: boolean;
  engineer_available: boolean;
  last_seen_at: Date | string;
};

function fromRow(row: DispatchRow): WorkerDispatch {
  return {
    schema: "mc.worker-dispatch/v1",
    dispatchId: row.dispatch_id,
    projectId: row.project_id,
    missionId: row.mission_id,
    issueNumber: row.issue_number,
    missionRevision: row.mission_revision,
    actor: row.actor,
    adapter: row.adapter,
    idempotencyKey: row.idempotency_key,
    missionDigest: row.mission_digest,
    packet: row.packet,
  };
}

async function recordPresence(client: PoolClient, health: WorkerHealth, current?: string) {
  const collision = await client.query<{ session_id: string }>(
    `SELECT session_id FROM v2_worker_presence WHERE worker_id=$1 AND last_seen_at > now() - interval '45 seconds' FOR UPDATE`,
    [health.workerId],
  );
  if (collision.rowCount && collision.rows[0].session_id !== health.sessionId)
    throw new Error("DUPLICATE_WORKER_ACTIVE");
  await client.query(
    `INSERT INTO v2_worker_presence(worker_id,display_name,session_id,status,architect_available,engineer_available,current_dispatch_id,last_seen_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,now()) ON CONFLICT(worker_id) DO UPDATE SET display_name=excluded.display_name,
     session_id=excluded.session_id,status=excluded.status,architect_available=excluded.architect_available,
     engineer_available=excluded.engineer_available,current_dispatch_id=excluded.current_dispatch_id,last_seen_at=now(),updated_at=now()`,
    [
      health.workerId,
      health.displayName,
      health.sessionId,
      health.status,
      health.architectAvailable,
      health.engineerAvailable,
      current ?? health.currentDispatchId ?? null,
    ],
  );
}

export class PostgresWorkerCoordinationStore implements WorkerCoordinationStore {
  async heartbeat(health: WorkerHealth) {
    await withTransaction((client) => recordPresence(client, health));
  }
  async get(dispatchId: string) {
    const result = await getDatabasePool().query<DispatchRow>(
      `SELECT * FROM v2_worker_dispatches WHERE dispatch_id=$1`,
      [dispatchId],
    );
    return result.rowCount ? fromRow(result.rows[0]) : undefined;
  }
  async enqueue(input: Omit<WorkerDispatch, "schema" | "dispatchId">) {
    const id = randomUUID();
    const result = await getDatabasePool().query<DispatchRow>(
      `INSERT INTO v2_worker_dispatches(dispatch_id,project_id,mission_id,issue_number,mission_revision,actor,adapter,idempotency_key,mission_digest,packet,status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'QUEUED') ON CONFLICT(idempotency_key) DO UPDATE SET updated_at=now()
       RETURNING *`,
      [
        id,
        input.projectId,
        input.missionId,
        input.issueNumber,
        input.missionRevision,
        input.actor,
        input.adapter,
        input.idempotencyKey,
        input.missionDigest,
        JSON.stringify(input.packet),
      ],
    );
    return fromRow(result.rows[0]);
  }
  async recoverFailed(dispatchId: string) {
    return withTransaction(async (client) => {
      const found = await client.query<DispatchRow>(
        `SELECT * FROM v2_worker_dispatches WHERE dispatch_id=$1 FOR UPDATE`,
        [dispatchId],
      );
      if (!found.rowCount || found.rows[0].status !== "FAILED") return undefined;
      const row = found.rows[0];
      const recovery = failedDispatchRecovery(row.actor, row.failure_code ?? undefined);
      if (!recovery) return undefined;
      await client.query(
        `UPDATE v2_worker_dispatches SET status='QUEUED',worker_id=NULL,worker_session_id=NULL,
         updated_at=now() WHERE dispatch_id=$1 AND status='FAILED'`,
        [dispatchId],
      );
      return recovery;
    });
  }
  async claim(health: WorkerHealth, _duplicateWindowMs: number) {
    void _duplicateWindowMs;
    return withTransaction(async (client) => {
      await recordPresence(client, health);
      await client.query(
        `UPDATE v2_worker_dispatches SET status='QUEUED',worker_id=NULL,worker_session_id=NULL,updated_at=now()
         WHERE status='CLAIMED' AND acknowledged_at < now() - interval '45 seconds'`,
      );
      const found = await client.query<DispatchRow>(
        `SELECT * FROM v2_worker_dispatches
         WHERE status='QUEUED' OR (status='COMPLETED' AND resulting_github_revision IS NULL)
         ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      if (!found.rowCount) return undefined;
      const row = found.rows[0];
      await client.query(
        `UPDATE v2_worker_dispatches SET status='CLAIMED',worker_id=$2,worker_session_id=$3,
        acknowledged_at=now(),updated_at=now() WHERE dispatch_id=$1`,
        [row.dispatch_id, health.workerId, health.sessionId],
      );
      await client.query(`UPDATE v2_worker_presence SET current_dispatch_id=$2 WHERE worker_id=$1`, [
        health.workerId,
        row.dispatch_id,
      ]);
      return fromRow(row);
    });
  }
  async complete(health: WorkerHealth, result: WorkerResult) {
    return withTransaction(async (client) => {
      await recordPresence(client, health, result.dispatchId);
      const found = await client.query<DispatchRow>(
        `SELECT * FROM v2_worker_dispatches WHERE dispatch_id=$1 FOR UPDATE`,
        [result.dispatchId],
      );
      if (!found.rowCount) throw new Error("Unknown worker dispatch");
      const row = found.rows[0];
      const digest = sha256(result);
      if (row.status === "COMPLETED") {
        if (row.result_sha256 !== digest) throw new Error("Conflicting duplicate worker result");
        return { dispatch: fromRow(row), duplicate: true };
      }
      if (row.status !== "CLAIMED" || row.worker_id !== health.workerId || row.worker_session_id !== health.sessionId)
        throw new Error("Worker result is not owned by the active claim");
      if (row.result_sha256 && row.result_sha256 !== digest) throw new Error("Conflicting retried worker result");
      await client.query(
        `UPDATE v2_worker_dispatches SET status='COMPLETED',result=$2,result_sha256=$3,
        provider_thread_id=$4,failure_code=NULL,completed_at=now(),updated_at=now() WHERE dispatch_id=$1`,
        [result.dispatchId, JSON.stringify(result), digest, result.providerThreadId],
      );
      return { dispatch: fromRow(row), duplicate: false };
    });
  }
  async markCommitted(dispatchId: string, githubRevision: number) {
    await getDatabasePool().query(
      `UPDATE v2_worker_dispatches SET resulting_github_revision=$2,updated_at=now() WHERE dispatch_id=$1`,
      [dispatchId, githubRevision],
    );
  }
  async fail(health: WorkerHealth, dispatchId: string | undefined, code: string) {
    await withTransaction(async (client) => {
      await recordPresence(client, health, dispatchId);
      if (dispatchId)
        await client.query(
          `UPDATE v2_worker_dispatches SET status='FAILED',failure_code=$2,updated_at=now() WHERE dispatch_id=$1 AND status='CLAIMED'`,
          [dispatchId, code],
        );
    });
  }
  async presence(offlineAfterMs: number) {
    const result = await getDatabasePool().query<PresenceRow>(
      `SELECT * FROM v2_worker_presence ORDER BY updated_at DESC LIMIT 1`,
    );
    if (!result.rowCount) return undefined;
    const row = result.rows[0];
    const lastSeenAt = new Date(row.last_seen_at).toISOString();
    const offline = Date.now() - Date.parse(lastSeenAt) > offlineAfterMs;
    return {
      workerId: row.worker_id,
      displayName: row.display_name,
      sessionId: row.session_id,
      status: offline ? "OFFLINE" : row.status,
      currentDispatchId: row.current_dispatch_id ?? undefined,
      architectAvailable: row.architect_available,
      engineerAvailable: row.engineer_available,
      lastSeenAt,
    };
  }
  async list() {
    const result = await getDatabasePool().query<DispatchRow>(`SELECT * FROM v2_worker_dispatches ORDER BY created_at`);
    return result.rows.map((row) => ({
      dispatch: fromRow(row),
      status: row.status,
      ...(row.resulting_github_revision ? { resultingGitHubRevision: row.resulting_github_revision } : {}),
      ...(row.provider_thread_id ? { providerThreadId: row.provider_thread_id } : {}),
      ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    }));
  }
}

export class MemoryWorkerCoordinationStore implements WorkerCoordinationStore {
  private dispatches = new Map<
    string,
    {
      dispatch: WorkerDispatch;
      status: string;
      resultHash?: string;
      githubRevision?: number;
      owner?: string;
      claimedAt?: string;
      failureCode?: string;
    }
  >();
  private worker?: WorkerPresence;
  private now = () => new Date();
  constructor(now?: () => Date) {
    if (now) this.now = now;
  }
  async heartbeat(health: WorkerHealth) {
    this.see(health);
  }
  async get(dispatchId: string) {
    const item = this.dispatches.get(dispatchId);
    return item ? structuredClone(item.dispatch) : undefined;
  }
  async enqueue(input: Omit<WorkerDispatch, "schema" | "dispatchId">) {
    const existing = Array.from(this.dispatches.values()).find(
      (item) => item.dispatch.idempotencyKey === input.idempotencyKey,
    );
    if (existing) return structuredClone(existing.dispatch);
    const dispatch: WorkerDispatch = { schema: "mc.worker-dispatch/v1", dispatchId: randomUUID(), ...input };
    this.dispatches.set(dispatch.dispatchId, { dispatch, status: "QUEUED" });
    return structuredClone(dispatch);
  }
  async recoverFailed(dispatchId: string) {
    const item = this.dispatches.get(dispatchId);
    if (!item || item.status !== "FAILED") return undefined;
    const recovery = failedDispatchRecovery(item.dispatch.actor, item.failureCode);
    if (!recovery) return undefined;
    item.status = "QUEUED";
    item.owner = undefined;
    item.claimedAt = undefined;
    return recovery;
  }
  private see(health: WorkerHealth) {
    if (
      this.worker &&
      this.worker.sessionId !== health.sessionId &&
      this.now().getTime() - Date.parse(this.worker.lastSeenAt) < 45_000
    )
      throw new Error("DUPLICATE_WORKER_ACTIVE");
    this.worker = { ...health, lastSeenAt: this.now().toISOString() };
  }
  async claim(health: WorkerHealth, _duplicateWindowMs: number) {
    this.see(health);
    for (const value of Array.from(this.dispatches.values()))
      if (
        value.status === "CLAIMED" &&
        value.claimedAt &&
        this.now().getTime() - Date.parse(value.claimedAt) > _duplicateWindowMs
      ) {
        value.status = "QUEUED";
        value.owner = undefined;
      }
    const item = Array.from(this.dispatches.values()).find((value) => value.status === "QUEUED");
    if (!item) return undefined;
    item.status = "CLAIMED";
    item.owner = `${health.workerId}:${health.sessionId}`;
    item.claimedAt = this.now().toISOString();
    this.worker = { ...this.worker!, currentDispatchId: item.dispatch.dispatchId };
    return structuredClone(item.dispatch);
  }
  async complete(health: WorkerHealth, result: WorkerResult) {
    this.see(health);
    const item = this.dispatches.get(result.dispatchId);
    if (!item) throw new Error("Unknown worker dispatch");
    const digest = sha256(result);
    if (item.status === "COMPLETED") {
      if (item.resultHash !== digest) throw new Error("Conflicting duplicate worker result");
      return { dispatch: structuredClone(item.dispatch), duplicate: true };
    }
    if (item.status !== "CLAIMED" || item.owner !== `${health.workerId}:${health.sessionId}`)
      throw new Error("Worker result is not owned by the active claim");
    item.status = "COMPLETED";
    item.resultHash = digest;
    item.failureCode = undefined;
    return { dispatch: structuredClone(item.dispatch), duplicate: false };
  }
  async markCommitted(dispatchId: string, githubRevision: number) {
    const item = this.dispatches.get(dispatchId);
    if (!item) throw new Error("Unknown worker dispatch");
    item.githubRevision = githubRevision;
  }
  async fail(health: WorkerHealth, dispatchId: string | undefined, code: string) {
    this.see(health);
    if (dispatchId) {
      const item = this.dispatches.get(dispatchId);
      if (item) {
        item.status = "FAILED";
        item.failureCode = code;
      }
    }
  }
  async presence(offlineAfterMs: number) {
    if (!this.worker) return undefined;
    return {
      ...this.worker,
      status:
        this.now().getTime() - Date.parse(this.worker.lastSeenAt) > offlineAfterMs
          ? ("OFFLINE" as const)
          : this.worker.status,
    };
  }
  async list() {
    return Array.from(this.dispatches.values()).map((item) => ({
      dispatch: structuredClone(item.dispatch),
      status: item.status,
      ...(item.githubRevision ? { resultingGitHubRevision: item.githubRevision } : {}),
      ...(item.failureCode ? { failureCode: item.failureCode } : {}),
    }));
  }
}
