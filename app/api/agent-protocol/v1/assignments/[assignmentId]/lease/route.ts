import { NextResponse } from "next/server";
import { renewAssignmentLease } from "@/application/pull-assignments";
import { completeProtocolMessage, releaseProtocolMessage } from "@/application/remote-agent-messages";
import { apiErrorResponse } from "@/lib/http-errors";
import { authenticatePullRequest } from "@/remote-agent/pull-request";
import { auditProtocolSecurityFailure, securityReason } from "@/remote-agent/security";

export async function POST(request: Request, { params }: { params: Promise<{ assignmentId: string }> }) {
  const { assignmentId } = await params;
  const path = `/api/agent-protocol/v1/assignments/${assignmentId}/lease`;
  let auth: Awaited<ReturnType<typeof authenticatePullRequest>> | undefined;
  try {
    auth = await authenticatePullRequest(request, path, "AgentAssignmentLeaseRenewed", "lease");
    if (auth.receipt.duplicate) return NextResponse.json(auth.receipt.acknowledgement);
    const lease = await renewAssignmentLease({
      credential: auth.credential,
      assignmentId,
      leaseOwner: String(auth.message.payload.leaseOwner ?? ""),
      leaseToken: String(auth.message.payload.leaseToken ?? ""),
    });
    const response = {
      protocolVersion: "1.0",
      messageId: auth.message.messageId,
      leaseExpiresAt: lease.lease_expires_at,
    };
    await completeProtocolMessage(auth.credential, auth.message.messageId, response);
    return NextResponse.json(response);
  } catch (error) {
    if (auth) await releaseProtocolMessage(auth.credential, auth.message.messageId).catch(() => undefined);
    await auditProtocolSecurityFailure(request, securityReason(error)).catch(() => undefined);
    return apiErrorResponse(error, "agent_assignment_lease_rejected");
  }
}
