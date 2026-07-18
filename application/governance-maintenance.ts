import { expireApproval } from "@/application/approval-commands";
import { applyActionProjection } from "@/application/action-projector";
import { rehydrateAction, transitionAction } from "@/domain/action-request";
import { getDatabasePool } from "@/lib/database";
import { appendEvents, loadAggregateEvents } from "@/lib/postgres-event-store";
import { stableUuid } from "@/lib/stable-id";
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
