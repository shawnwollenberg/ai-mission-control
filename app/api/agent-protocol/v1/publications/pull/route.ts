import { NextResponse } from "next/server";
import { claimPublicationAssignment } from "@/application/publication-assignments";
import { completeProtocolMessage, releaseProtocolMessage } from "@/application/remote-agent-messages";
import { authenticatePullRequest } from "@/remote-agent/pull-request";
import { apiErrorResponse } from "@/lib/http-errors";

const path = "/api/agent-protocol/v1/publications/pull";
export async function POST(request: Request) {
  let auth: Awaited<ReturnType<typeof authenticatePullRequest>> | undefined;
  try {
    auth = await authenticatePullRequest(request, path, "AgentPublicationPullRequested", "pull");
    if (auth.receipt.duplicate) return NextResponse.json(auth.receipt.acknowledgement);
    const row = await claimPublicationAssignment(auth.credential.workspace_id, auth.credential.agent_id);
    const response = {
      protocolVersion: "1.0",
      messageId: auth.message.messageId,
      publication: row
        ? {
            assignmentId: row.assignment_id,
            actionRequestId: row.action_request_id,
            executionId: row.execution_id,
            repositoryId: row.repository_id,
            ...row.payload,
          }
        : null,
    };
    await completeProtocolMessage(auth.credential, auth.message.messageId, response);
    return row ? NextResponse.json(response) : new NextResponse(null, { status: 204 });
  } catch (error) {
    if (auth) await releaseProtocolMessage(auth.credential, auth.message.messageId).catch(() => undefined);
    return apiErrorResponse(error, "publication_assignment_pull_rejected");
  }
}
