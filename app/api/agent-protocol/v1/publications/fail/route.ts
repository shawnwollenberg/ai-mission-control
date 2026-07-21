import { NextResponse } from "next/server";
import { failMissionAgentPublication } from "@/application/action-executor";
import { completeProtocolMessage, releaseProtocolMessage } from "@/application/remote-agent-messages";
import { apiErrorResponse } from "@/lib/http-errors";
import { authenticatePullRequest } from "@/remote-agent/pull-request";

const path = "/api/agent-protocol/v1/publications/fail";

export async function POST(request: Request) {
  let auth: Awaited<ReturnType<typeof authenticatePullRequest>> | undefined;
  try {
    auth = await authenticatePullRequest(request, path, "AgentPublicationFailed", "repository");
    if (auth.receipt.duplicate) return NextResponse.json(auth.receipt.acknowledgement);
    const actionRequestId = String(auth.message.payload.actionRequestId ?? "");
    const summary = String(auth.message.payload.summary ?? "Mission Agent publication preflight failed.");
    await failMissionAgentPublication(
      auth.credential.workspace_id,
      actionRequestId,
      auth.credential.agent_id,
      summary,
    );
    const response = { protocolVersion: "1.0", messageId: auth.message.messageId, status: "failed" };
    await completeProtocolMessage(auth.credential, auth.message.messageId, response);
    return NextResponse.json(response);
  } catch (error) {
    if (auth) await releaseProtocolMessage(auth.credential, auth.message.messageId).catch(() => undefined);
    return apiErrorResponse(error, "publication_failure_rejected");
  }
}
