import { NextResponse } from "next/server";
import { validateExecutionLease } from "@/application/pull-assignments";
import { completeProtocolMessage, releaseProtocolMessage } from "@/application/remote-agent-messages";
import { apiErrorResponse } from "@/lib/http-errors";
import { getDatabasePool } from "@/lib/database";
import { authenticatePullRequest } from "@/remote-agent/pull-request";
import { NotFoundError } from "@/lib/application-errors";

export async function POST(request: Request, { params }: { params: Promise<{ assignmentId: string }> }) {
  const { assignmentId } = await params;
  const path = `/api/agent-protocol/v1/assignments/${assignmentId}/approval`;
  let auth: Awaited<ReturnType<typeof authenticatePullRequest>> | undefined;
  try {
    auth = await authenticatePullRequest(request, path, "AgentApprovalStatusChecked", "lease");
    if (auth.receipt.duplicate) return NextResponse.json(auth.receipt.acknowledgement);
    const lease = await validateExecutionLease({
      credential: auth.credential,
      assignmentId,
      executionId: String(auth.message.executionId ?? ""),
      leaseOwner: String(auth.message.payload.leaseOwner ?? ""),
      leaseToken: String(auth.message.payload.leaseToken ?? ""),
    });
    const approval = (
      await getDatabasePool().query(
        `SELECT approval_id,status,action_hash,decided_at,decision_reason FROM approval_projections
         WHERE workspace_id=$1 AND execution_id=$2 AND agent_id=$3 AND approval_type='remote_workflow'
         ORDER BY created_at DESC LIMIT 1`,
        [auth.credential.workspace_id, lease.execution_id, auth.credential.agent_id],
      )
    ).rows[0];
    if (!approval) throw new NotFoundError("Execution approval");
    const response = {
      protocolVersion: "1.0",
      messageId: auth.message.messageId,
      approvalId: approval.approval_id,
      status: approval.status,
      actionHash: approval.action_hash,
      decidedAt: approval.decided_at,
      decisionReason: approval.decision_reason,
    };
    await completeProtocolMessage(auth.credential, auth.message.messageId, response);
    return NextResponse.json(response);
  } catch (error) {
    if (auth) await releaseProtocolMessage(auth.credential, auth.message.messageId).catch(() => undefined);
    return apiErrorResponse(error, "agent_approval_status_check_rejected");
  }
}
