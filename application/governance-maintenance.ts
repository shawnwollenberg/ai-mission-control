import { expireApproval } from "@/application/approval-commands";
import { applyActionProjection } from "@/application/action-projector";
import { rehydrateAction, transitionAction } from "@/domain/action-request";
import { getDatabasePool } from "@/lib/database";
import { appendEvents, loadAggregateEvents } from "@/lib/postgres-event-store";
import { stableUuid } from "@/lib/stable-id";
import { handleExecutionTransition } from "@/application/execution-commands";
import { handleTaskTransition } from "@/application/task-commands";
import { coordinateAfterTask } from "@/application/mission-coordinator";
import { reconcileConsensusState } from "@/application/consensus-plan-commands";
export async function expireDueApprovals(workerId: string) {
  const rows = (
    await getDatabasePool().query(
      "SELECT workspace_id,approval_id,action_request_id FROM approval_projections WHERE status='pending' AND expires_at<=now() FOR UPDATE SKIP LOCKED LIMIT 100",
    )
  ).rows;
  for (const row of rows) {
    await expireApproval({ workspaceId: row.workspace_id, approvalId: row.approval_id, actorId: workerId });
    if (row.action_request_id) {
      const events = await loadAggregateEvents({
          workspaceId: row.workspace_id,
          aggregateType: "action_request",
          aggregateId: row.action_request_id,
        }),
        state = rehydrateAction(events);
      if (state?.status === "waiting_for_approval")
        await appendEvents({
          workspaceId: row.workspace_id,
          aggregateType: "action_request",
          aggregateId: state.id,
          missionId: state.missionId,
          expectedVersion: state.version,
          commandId: stableUuid(`expire-action:${state.id}`),
          commandType: "ExpireAction",
          correlationId: state.missionId,
          causationId: events.at(-1)?.eventId,
          actor: { type: "system", id: workerId },
          events: [transitionAction(state, "expired", { approvalId: row.approval_id })],
          applyProjections: applyActionProjection,
        });
    }
  }
  return rows.length;
}

export async function reconcileConsensusOperations(workerId: string) {
  let repaired = await reconcileConsensusState(workerId);
  const timedOut = await getDatabasePool().query<{
    workspace_id: string;
    execution_id: string;
    mission_id: string;
    task_id: string;
  }>(
    `SELECT e.workspace_id,e.execution_id,e.mission_id,e.task_id FROM execution_projections e
     JOIN mission_projections m ON m.workspace_id=e.workspace_id AND m.mission_id=e.mission_id
     WHERE m.mission_type IN('consensus_plan','repository_change') AND e.timeout_at<=now()
       AND e.status NOT IN('succeeded','failed','timed_out','cancelled') LIMIT 100`,
  );
  for (const execution of timedOut.rows) {
    const actor = { workspaceId: execution.workspace_id, id: workerId, type: "system" as const };
    await handleExecutionTransition({
      actor,
      commandId: stableUuid(`consensus-timeout:${execution.execution_id}`),
      executionId: execution.execution_id,
      target: "timed_out",
      details: { classification: "provider_wall_clock_timeout" },
    });
    await handleTaskTransition({
      actor,
      commandId: stableUuid(`consensus-timeout-task:${execution.task_id}`),
      taskId: execution.task_id,
      target: "failed",
      details: { reason: "execution_timed_out" },
    });
    await coordinateAfterTask(execution.workspace_id, execution.mission_id, execution.task_id, "task.timed_out");
    await getDatabasePool().query(
      `UPDATE pull_assignments SET status='completed',lease_token_hash=NULL,lease_expires_at=NULL,updated_at=now()
       WHERE workspace_id=$1 AND execution_id=$2`,
      [execution.workspace_id, execution.execution_id],
    );
    repaired += 1;
  }
  const stalled = await getDatabasePool().query<{
    workspace_id: string;
    execution_id: string;
    mission_id: string;
    task_id: string;
  }>(
    `SELECT e.workspace_id,e.execution_id,e.mission_id,e.task_id FROM execution_projections e
     JOIN mission_projections m ON m.workspace_id=e.workspace_id AND m.mission_id=e.mission_id
     JOIN execution_heartbeats h ON h.workspace_id=e.workspace_id AND h.execution_id=e.execution_id
     WHERE m.mission_type IN('consensus_plan','repository_change')
       AND h.lease_expires_at<=now() AND e.status IN('preparing','running','verifying')
     LIMIT 100`,
  );
  for (const execution of stalled.rows) {
    const actor = { workspaceId: execution.workspace_id, id: workerId, type: "system" as const };
    await handleExecutionTransition({
      actor,
      commandId: stableUuid(`execution-heartbeat-timeout:${execution.execution_id}`),
      executionId: execution.execution_id,
      target: "timed_out",
      details: { classification: "execution_heartbeat_expired" },
    });
    await handleTaskTransition({
      actor,
      commandId: stableUuid(`execution-heartbeat-timeout-task:${execution.task_id}`),
      taskId: execution.task_id,
      target: "failed",
      details: { reason: "execution_heartbeat_expired" },
    });
    await coordinateAfterTask(execution.workspace_id, execution.mission_id, execution.task_id, "task.timed_out");
    await getDatabasePool().query(
      `UPDATE pull_assignments SET status='completed',lease_token_hash=NULL,lease_expires_at=NULL,updated_at=now()
       WHERE workspace_id=$1 AND execution_id=$2`,
      [execution.workspace_id, execution.execution_id],
    );
    repaired += 1;
  }
  return repaired;
}
