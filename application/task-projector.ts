import type { PoolClient } from "pg";
import type { DomainEvent } from "@/lib/postgres-event-store";

export async function refreshMissionExecutionSummary(client: PoolClient, workspaceId: string, missionId: string) {
  await client.query(
    `UPDATE mission_projections m SET
    total_task_count = s.total, completed_task_count = s.completed, blocked_task_count = s.blocked,
    ready_task_count = s.ready, running_task_count = s.running,
    waiting_approval_task_count = s.waiting, failed_task_count = s.failed,
    cancelled_task_count = s.cancelled,
    current_critical_blocker = (SELECT name FROM task_projections WHERE workspace_id=$1 AND mission_id=$2 AND status IN ('failed','waiting_for_approval','blocked') ORDER BY CASE status WHEN 'failed' THEN 0 WHEN 'waiting_for_approval' THEN 1 ELSE 2 END, created_at LIMIT 1)
  FROM (SELECT count(*)::int total, count(*) FILTER (WHERE status='completed')::int completed,
    count(*) FILTER (WHERE status='blocked')::int blocked, count(*) FILTER (WHERE status='ready')::int ready,
    count(*) FILTER (WHERE status IN ('assigned','running','verifying'))::int running,
    count(*) FILTER (WHERE status='waiting_for_approval')::int waiting,
    count(*) FILTER (WHERE status='failed')::int failed,
    count(*) FILTER (WHERE status='cancelled')::int cancelled
    FROM task_projections WHERE workspace_id=$1 AND mission_id=$2) s
  WHERE m.workspace_id=$1 AND m.mission_id=$2`,
    [workspaceId, missionId],
  );
}

export async function applyTaskProjection(client: PoolClient, events: DomainEvent[]): Promise<void> {
  for (const event of events) {
    const missionId = event.missionId ?? String(event.payload.missionId);
    if (event.eventType === "task.created") {
      await client.query(
        `INSERT INTO task_projections (
        workspace_id, task_id, mission_id, aggregate_version, name, instructions, expected_output, status,
        priority, risk_level, required_capabilities, maximum_attempts, timeout_seconds, approval_requirements,
        verification_requirements, required_resources, current_attempt, created_at, updated_at, last_event_position
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10,$11,$12,$13,$14,$15,0,$16,$16,$17)
      ON CONFLICT (workspace_id,task_id) DO UPDATE SET aggregate_version=EXCLUDED.aggregate_version,
        status=EXCLUDED.status, updated_at=EXCLUDED.updated_at, last_event_position=EXCLUDED.last_event_position`,
        [
          event.workspaceId,
          event.aggregateId,
          missionId,
          event.aggregateVersion,
          event.payload.name,
          event.payload.instructions,
          event.payload.expectedOutput,
          event.payload.priority,
          event.payload.riskLevel,
          JSON.stringify(event.payload.requiredCapabilities),
          event.payload.maximumAttempts,
          event.payload.timeoutSeconds,
          JSON.stringify(event.payload.approvalPolicy),
          JSON.stringify(event.payload.verificationRequirements),
          JSON.stringify(event.payload.requiredResources ?? []),
          event.occurredAt,
          event.position,
        ],
      );
    } else if (event.eventType === "task.dependency_added") {
      await client.query(
        `INSERT INTO task_dependencies (workspace_id,mission_id,task_id,depends_on_task_id,created_event_id,created_at)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [
          event.workspaceId,
          missionId,
          event.aggregateId,
          event.payload.dependsOnTaskId,
          event.eventId,
          event.occurredAt,
        ],
      );
      await client.query(
        `UPDATE task_projections SET aggregate_version=$3,updated_at=$4,last_event_position=$5
        WHERE workspace_id=$1 AND task_id=$2`,
        [event.workspaceId, event.aggregateId, event.aggregateVersion, event.occurredAt, event.position],
      );
    } else if (event.eventType.startsWith("task.")) {
      await client.query(
        `UPDATE task_projections SET status=COALESCE($3,status), aggregate_version=$4,
        assigned_executor=COALESCE($5,assigned_executor), current_attempt=COALESCE($6,current_attempt),
        progress_summary=COALESCE($7,progress_summary), updated_at=$8,last_event_position=$9
        WHERE workspace_id=$1 AND task_id=$2`,
        [
          event.workspaceId,
          event.aggregateId,
          event.payload.status ?? null,
          event.aggregateVersion,
          event.payload.assignedExecutor ?? null,
          event.payload.currentAttempt ?? null,
          event.payload.summary ?? null,
          event.occurredAt,
          event.position,
        ],
      );
    }
    await refreshMissionExecutionSummary(client, event.workspaceId, missionId);
  }
}
