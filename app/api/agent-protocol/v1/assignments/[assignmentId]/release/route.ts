import { NextResponse } from "next/server";
import { releaseAssignment } from "@/application/pull-assignments";
import { completeProtocolMessage, releaseProtocolMessage } from "@/application/remote-agent-messages";
import { apiErrorResponse } from "@/lib/http-errors";
import { authenticatePullRequest } from "@/remote-agent/pull-request";

export async function POST(request: Request, { params }: { params: Promise<{ assignmentId: string }> }) {
  const { assignmentId } = await params;
  const path = `/api/agent-protocol/v1/assignments/${assignmentId}/release`;
  let auth: Awaited<ReturnType<typeof authenticatePullRequest>> | undefined;
  try {
    auth = await authenticatePullRequest(request, path, "AgentAssignmentReleased", "lease");
    if (auth.receipt.duplicate) return NextResponse.json(auth.receipt.acknowledgement);
    await releaseAssignment({
      credential: auth.credential,
      assignmentId,
      leaseOwner: String(auth.message.payload.leaseOwner ?? ""),
      leaseToken: String(auth.message.payload.leaseToken ?? ""),
    });
    const response = { protocolVersion: "1.0", messageId: auth.message.messageId, released: true };
    await completeProtocolMessage(auth.credential, auth.message.messageId, response);
    return NextResponse.json(response);
  } catch (error) {
    if (auth) await releaseProtocolMessage(auth.credential, auth.message.messageId).catch(() => undefined);
    return apiErrorResponse(error, "agent_assignment_release_rejected");
  }
}
