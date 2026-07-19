import { NextResponse } from "next/server";
import { claimNextAssignment } from "@/application/pull-assignments";
import { completeProtocolMessage, releaseProtocolMessage } from "@/application/remote-agent-messages";
import { apiErrorResponse } from "@/lib/http-errors";
import { authenticatePullRequest } from "@/remote-agent/pull-request";
import { auditProtocolSecurityFailure, securityReason } from "@/remote-agent/security";

const path = "/api/agent-protocol/v1/assignments/pull";
export async function POST(request: Request) {
  let authenticated: Awaited<ReturnType<typeof authenticatePullRequest>> | undefined;
  try {
    authenticated = await authenticatePullRequest(request, path, "AgentAssignmentPullRequested", "pull");
    if (authenticated.receipt.duplicate)
      return NextResponse.json(authenticated.receipt.acknowledgement, { status: 200 });
    const leaseOwner = String(authenticated.message.payload.leaseOwner ?? "");
    const waitSeconds = Math.min(Math.max(Number(authenticated.message.payload.waitSeconds ?? 0), 0), 20);
    const deadline = Date.now() + waitSeconds * 1000;
    let claimed;
    do {
      claimed = await claimNextAssignment({ credential: authenticated.credential, leaseOwner });
      if (claimed || Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 750));
    } while (true);
    const result = claimed
      ? {
          protocolVersion: "1.0",
          messageId: authenticated.message.messageId,
          assignment: {
            assignmentId: claimed.assignment.assignment_id,
            executionId: claimed.assignment.execution_id,
            missionId: claimed.assignment.mission_id,
            taskId: claimed.assignment.task_id,
            agentId: claimed.assignment.agent_id,
            attempt: claimed.assignment.attempt,
            leaseOwner: claimed.assignment.lease_owner,
            leaseToken: claimed.leaseToken,
            leaseExpiresAt: claimed.assignment.lease_expires_at,
            resumed: claimed.resumed,
            ...claimed.assignment.payload,
          },
        }
      : { protocolVersion: "1.0", messageId: authenticated.message.messageId, assignment: null };
    await completeProtocolMessage(authenticated.credential, authenticated.message.messageId, result);
    return claimed ? NextResponse.json(result) : new NextResponse(null, { status: 204 });
  } catch (error) {
    if (authenticated)
      await releaseProtocolMessage(authenticated.credential, authenticated.message.messageId).catch(() => undefined);
    await auditProtocolSecurityFailure(request, securityReason(error)).catch(() => undefined);
    return apiErrorResponse(error, "agent_assignment_pull_rejected");
  }
}
