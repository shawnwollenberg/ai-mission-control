import { NextResponse } from "next/server";
import { acknowledgeAssignment } from "@/application/pull-assignments";
import {
  processRemoteMessage,
  completeProtocolMessage,
  releaseProtocolMessage,
} from "@/application/remote-agent-messages";
import { apiErrorResponse } from "@/lib/http-errors";
import { authenticatePullRequest } from "@/remote-agent/pull-request";
import { auditProtocolSecurityFailure, securityReason } from "@/remote-agent/security";

export async function POST(request: Request, { params }: { params: Promise<{ assignmentId: string }> }) {
  const { assignmentId } = await params;
  const path = `/api/agent-protocol/v1/assignments/${assignmentId}/acknowledge`;
  let auth: Awaited<ReturnType<typeof authenticatePullRequest>> | undefined;
  try {
    auth = await authenticatePullRequest(request, path, "AgentAssignmentAcknowledged", "lease");
    if (auth.receipt.duplicate) return NextResponse.json(auth.receipt.acknowledgement);
    const assignment = await acknowledgeAssignment({
      credential: auth.credential,
      assignmentId,
      leaseOwner: String(auth.message.payload.leaseOwner ?? ""),
      leaseToken: String(auth.message.payload.leaseToken ?? ""),
    });
    const result =
      assignment.execution_status === "requested"
        ? await processRemoteMessage(
            {
              ...auth.message,
              messageType: "ExecutionAccepted",
              missionId: assignment.mission_id,
              taskId: assignment.task_id,
              executionId: assignment.execution_id,
              attempt: assignment.attempt,
              payload: { stage: "assignment_received", summary: "Mission Agent acknowledged the assignment" },
            },
            auth.credential,
          )
        : { status: "resumed", executionStatus: assignment.execution_status };
    const response = { protocolVersion: "1.0", messageId: auth.message.messageId, received: true, result };
    await completeProtocolMessage(auth.credential, auth.message.messageId, response);
    return NextResponse.json(response, { status: 202 });
  } catch (error) {
    if (auth) await releaseProtocolMessage(auth.credential, auth.message.messageId).catch(() => undefined);
    await auditProtocolSecurityFailure(request, securityReason(error)).catch(() => undefined);
    return apiErrorResponse(error, "agent_assignment_acknowledgement_rejected");
  }
}
