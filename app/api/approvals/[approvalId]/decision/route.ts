import { NextResponse } from "next/server";
import { resolveApproval } from "@/application/simulated-executor";
import { requireApiIdentity, requireMutationOrigin, unauthenticatedResponse } from "@/lib/request-auth";
import { apiErrorResponse } from "@/lib/http-errors";
import { getDatabasePool } from "@/lib/database";
import { resolveActionApproval } from "@/application/action-commands";
import { decideApproval } from "@/application/approval-commands";
import { ValidationFailedError } from "@/lib/application-errors";
export async function POST(request: Request, { params }: { params: Promise<{ approvalId: string }> }) {
  const origin = requireMutationOrigin(request);
  if (origin) return origin;
  const identity = await requireApiIdentity();
  if (!identity) return unauthenticatedResponse();
  try {
    const { approvalId } = await params;
    const body = (await request.json()) as { decision: "grant" | "deny"; reason?: string };
    const actionApproval = await getDatabasePool().query(
      "SELECT action_request_id,approval_type FROM approval_projections WHERE workspace_id=$1 AND approval_id=$2",
      [identity.workspaceId, approvalId],
    );
    if (actionApproval.rows[0]?.action_request_id) {
      const applied = await resolveActionApproval({
        actor: { workspaceId: identity.workspaceId, id: identity.userId, type: "human", role: identity.role },
        approvalId,
        granted: body.decision === "grant",
        reason: body.reason ?? "Decision recorded by mission owner",
      });
      return NextResponse.json({ applied });
    }
    if (["remote_workflow", "consensus_plan"].includes(actionApproval.rows[0]?.approval_type)) {
      if (actionApproval.rows[0]?.approval_type === "consensus_plan" && identity.role !== "owner")
        throw new ValidationFailedError("Workspace owner permission is required for consensus-plan approval");
      const result = await decideApproval({
        workspaceId: identity.workspaceId,
        approvalId,
        granted: body.decision === "grant",
        actorId: identity.userId,
        reason: body.reason ?? "Decision recorded by mission owner",
      });
      return NextResponse.json({ applied: result.applied });
    }
    const applied = await resolveApproval({
      workspaceId: identity.workspaceId,
      approvalId,
      granted: body.decision === "grant",
      decidedBy: identity.userId,
      reason: body.reason ?? "Decision recorded by mission owner",
    });
    return NextResponse.json({ applied });
  } catch (error) {
    return apiErrorResponse(error, "approval_decision_failed");
  }
}
