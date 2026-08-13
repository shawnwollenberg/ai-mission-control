import { NextResponse } from "next/server";
import { authenticatePullRequest } from "@/remote-agent/pull-request";
import { claimRemoteProjectBrainAssignment } from "@/application/remote-project-brain-assignments";
import { completeProtocolMessage, releaseProtocolMessage } from "@/application/remote-agent-messages";
import { auditProtocolSecurityFailure, securityReason } from "@/remote-agent/security";
import { apiErrorResponse } from "@/lib/http-errors";

const path = "/api/agent-protocol/v1/project-brain/pull";

export async function POST(request: Request) {
  let authenticated: Awaited<ReturnType<typeof authenticatePullRequest>> | undefined;
  try {
    authenticated = await authenticatePullRequest(request, path, "AgentProjectBrainPullRequested", "pull");
    if (authenticated.receipt.duplicate)
      return NextResponse.json(authenticated.receipt.acknowledgement, { status: 200 });
    const leaseOwner = String(authenticated.message.payload.leaseOwner ?? "");
    const claimed = await claimRemoteProjectBrainAssignment({
      credential: authenticated.credential,
      leaseOwner,
    });
    const result = claimed
      ? {
          protocolVersion: "1.0",
          messageId: authenticated.message.messageId,
          assignment: {
            assignmentId: claimed.assignment.assignment_id,
            operationId: claimed.assignment.operation_id,
            repositoryId: claimed.assignment.repository_id,
            missionId: claimed.assignment.mission_id,
            executionId: claimed.assignment.execution_id,
            agentId: claimed.assignment.agent_id,
            leaseOwner: claimed.assignment.lease_owner,
            leaseToken: claimed.leaseToken,
            leaseIssuedAt: new Date(claimed.assignment.last_renewed_at).toISOString(),
            leaseExpiresAt: new Date(claimed.assignment.lease_expires_at).toISOString(),
            requestChecksum: claimed.assignment.request_checksum,
            ...claimed.assignment.request,
          },
        }
      : { protocolVersion: "1.0", messageId: authenticated.message.messageId, assignment: null };
    await completeProtocolMessage(authenticated.credential, authenticated.message.messageId, result, {
      leaseKind: "project_brain_assignment",
    });
    return claimed ? NextResponse.json(result) : new NextResponse(null, { status: 204 });
  } catch (error) {
    if (authenticated)
      await releaseProtocolMessage(authenticated.credential, authenticated.message.messageId).catch(() => undefined);
    await auditProtocolSecurityFailure(request, securityReason(error)).catch(() => undefined);
    return apiErrorResponse(error, "project_brain_assignment_pull_rejected");
  }
}
