import { NextResponse } from "next/server";
import { removeMissionAgentRepositoryAssociation } from "@/application/registry";
import { completeProtocolMessage, releaseProtocolMessage } from "@/application/remote-agent-messages";
import { apiErrorResponse } from "@/lib/http-errors";
import { authenticatePullRequest } from "@/remote-agent/pull-request";
import { auditProtocolSecurityFailure, securityReason } from "@/remote-agent/security";

const path = "/api/agent-protocol/v1/repositories/remove";
export async function POST(request: Request) {
  let auth: Awaited<ReturnType<typeof authenticatePullRequest>> | undefined;
  try {
    auth = await authenticatePullRequest(request, path, "AgentRepositoryRemoved", "repository");
    if (auth.receipt.duplicate) return NextResponse.json(auth.receipt.acknowledgement);
    const repository = await removeMissionAgentRepositoryAssociation({
      workspaceId: auth.credential.workspace_id,
      agentId: auth.credential.agent_id,
      repositoryId: String(auth.message.payload.repositoryId ?? ""),
    });
    const response = { protocolVersion: "1.0", messageId: auth.message.messageId, repository };
    await completeProtocolMessage(auth.credential, auth.message.messageId, response);
    return NextResponse.json(response);
  } catch (error) {
    if (auth) await releaseProtocolMessage(auth.credential, auth.message.messageId).catch(() => undefined);
    await auditProtocolSecurityFailure(request, securityReason(error)).catch(() => undefined);
    return apiErrorResponse(error, "mission_agent_repository_removal_rejected");
  }
}
