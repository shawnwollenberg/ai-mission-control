import { NextResponse } from "next/server";
import { authenticatePullRequest } from "@/remote-agent/pull-request";
import { recordPublicationPush } from "@/application/publication-assignments";
import { finalizeMissionAgentPublication } from "@/application/action-executor";
import { completeProtocolMessage, releaseProtocolMessage } from "@/application/remote-agent-messages";
import { apiErrorResponse } from "@/lib/http-errors";

const path = "/api/agent-protocol/v1/publications/complete";
export async function POST(request: Request) {
  let auth: Awaited<ReturnType<typeof authenticatePullRequest>> | undefined;
  try {
    auth = await authenticatePullRequest(request, path, "AgentPublicationPushCompleted", "repository");
    if (auth.receipt.duplicate) return NextResponse.json(auth.receipt.acknowledgement);
    const actionRequestId = String(auth.message.payload.actionRequestId ?? "");
    await recordPublicationPush({
      workspaceId: auth.credential.workspace_id,
      agentId: auth.credential.agent_id,
      actionRequestId,
      branch: String(auth.message.payload.branch ?? ""),
      commit: String(auth.message.payload.commit ?? ""),
      remoteCommit: String(auth.message.payload.remoteCommit ?? ""),
    });
    const publication = await finalizeMissionAgentPublication(
      auth.credential.workspace_id,
      actionRequestId,
      auth.credential.agent_id,
    );
    const response = { protocolVersion: "1.0", messageId: auth.message.messageId, publication };
    await completeProtocolMessage(auth.credential, auth.message.messageId, response);
    return NextResponse.json(response);
  } catch (error) {
    if (auth) await releaseProtocolMessage(auth.credential, auth.message.messageId).catch(() => undefined);
    return apiErrorResponse(error, "publication_completion_rejected");
  }
}
