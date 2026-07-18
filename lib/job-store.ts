import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { getDatabasePool, withTransaction } from "@/lib/database";

export type Job = {
  jobId: string;
  workspaceId: string | null;
  jobType: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  correlationId: string | null;
};
type JobRow = {
  job_id: string;
  workspace_id: string | null;
  job_type: string;
  payload: Record<string, unknown>;
  attempt_count: number;
  max_attempts: number;
  correlation_id: string | null;
};
const map = (r: JobRow): Job => ({
  jobId: r.job_id,
  workspaceId: r.workspace_id,
  jobType: r.job_type,
  payload: r.payload,
  attempts: r.attempt_count,
  maxAttempts: r.max_attempts,
  correlationId: r.correlation_id,
});

export async function enqueueJob(
  input: {
    workspaceId?: string;
    jobType: string;
    payload?: Record<string, unknown>;
    idempotencyKey: string;
    priority?: number;
    maxAttempts?: number;
    availableAt?: string;
    correlationId?: string;
  },
  client?: PoolClient,
) {
  const db = client ?? getDatabasePool();
  const jobId = randomUUID();
  const result = await db.query<{ job_id: string }>(
    `INSERT INTO jobs(workspace_id,job_id,job_type,payload,idempotency_key,max_attempts,available_at,correlation_id,priority)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(workspace_id,job_type,idempotency_key) DO UPDATE SET updated_at=jobs.updated_at RETURNING job_id`,
    [
      input.workspaceId ?? null,
      jobId,
      input.jobType,
      input.payload ?? {},
      input.idempotencyKey,
      input.maxAttempts ?? 5,
      input.availableAt ?? new Date().toISOString(),
      input.correlationId ?? null,
      input.priority ?? 0,
    ],
  );
  return result.rows[0].job_id;
}

export async function claimJob(
  workerId: string,
  leaseSeconds = 30,
  workspaceId?: string,
  jobType?: string,
): Promise<Job | undefined> {
  return withTransaction(async (client) => {
    await client.query(
      `UPDATE jobs SET status='pending',lease_owner=NULL,lease_expires_at=NULL WHERE status='processing' AND lease_expires_at<now()`,
    );
    const result = await client.query<JobRow>(
      `SELECT job_id,workspace_id,job_type,payload,attempt_count,max_attempts,correlation_id FROM jobs
       WHERE status IN('pending','failed') AND available_at<=now() AND ($1::uuid IS NULL OR workspace_id=$1)
         AND ($2::text IS NULL OR job_type=$2)
       ORDER BY priority DESC,id FOR UPDATE SKIP LOCKED LIMIT 1`,
      [workspaceId ?? null, jobType ?? null],
    );
    if (!result.rowCount) return undefined;
    const row = result.rows[0];
    await client.query(
      `UPDATE jobs SET status='processing',attempt_count=attempt_count+1,lease_owner=$2,locked_at=now(),lease_expires_at=now()+($3*interval '1 second'),updated_at=now() WHERE job_id=$1`,
      [row.job_id, workerId, leaseSeconds],
    );
    row.attempt_count += 1;
    return map(row);
  });
}
export async function renewJobLease(jobId: string, workerId: string, leaseSeconds = 30) {
  const result = await getDatabasePool().query(
    "UPDATE jobs SET lease_expires_at=now()+($3*interval '1 second'),updated_at=now() WHERE job_id=$1 AND lease_owner=$2 AND status='processing'",
    [jobId, workerId, leaseSeconds],
  );
  return result.rowCount === 1;
}
export async function completeJob(jobId: string, workerId: string) {
  await getDatabasePool().query(
    "UPDATE jobs SET status='completed',completed_at=now(),updated_at=now(),lease_owner=NULL,locked_at=NULL,lease_expires_at=NULL WHERE job_id=$1 AND lease_owner=$2",
    [jobId, workerId],
  );
}
export async function failJob(job: Job, workerId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  await withTransaction(async (client) => {
    if (job.attempts >= job.maxAttempts) {
      await client.query(
        "UPDATE jobs SET status='dead_letter',last_error=$3,updated_at=now(),lease_owner=NULL,locked_at=NULL,lease_expires_at=NULL WHERE job_id=$1 AND lease_owner=$2",
        [job.jobId, workerId, { message }],
      );
      await client.query(
        "INSERT INTO dead_letters(workspace_id,job_id,job_type,payload,error,attempt_count) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(job_id) DO NOTHING",
        [job.workspaceId, job.jobId, job.jobType, job.payload, { message }, job.attempts],
      );
    } else {
      const delay = Math.min(60, 2 ** job.attempts);
      await client.query(
        "UPDATE jobs SET status='failed',last_error=$3,available_at=now()+($4*interval '1 second'),updated_at=now(),lease_owner=NULL,locked_at=NULL,lease_expires_at=NULL WHERE job_id=$1 AND lease_owner=$2",
        [job.jobId, workerId, { message }, delay],
      );
    }
  });
}
