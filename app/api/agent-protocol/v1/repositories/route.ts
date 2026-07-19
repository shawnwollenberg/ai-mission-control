import { NextResponse } from "next/server";
import { registerMissionAgentRepository } from "@/application/registry";
import { completeProtocolMessage, releaseProtocolMessage } from "@/application/remote-agent-messages";
import { apiErrorResponse } from "@/lib/http-errors";
import { authenticatePullRequest } from "@/remote-agent/pull-request";
import { auditProtocolSecurityFailure, securityReason } from "@/remote-agent/security";

const path = "/api/agent-protocol/v1/repositories";
export async function POST(request: Request) {
  let auth: Awaited<ReturnType<typeof authenticatePullRequest>> | undefined;
  try {
    auth = await authenticatePullRequest(request, path, "AgentRepositoryRegistered", "repository");
    if (auth.receipt.duplicate) return NextResponse.json(auth.receipt.acknowledgement);
    const repository = await registerMissionAgentRepository({
      workspaceId: auth.credential.workspace_id,
      agentId: auth.credential.agent_id,
      name: String(auth.message.payload.name ?? ""),
      fingerprint: String(auth.message.payload.fingerprint ?? ""),
      defaultBranch: String(auth.message.payload.defaultBranch ?? ""),
      remoteUrl: auth.message.payload.remoteUrl ? String(auth.message.payload.remoteUrl) : undefined,
      commit: auth.message.payload.commit ? String(auth.message.payload.commit) : undefined,
    });
    const response = { protocolVersion: "1.0", messageId: auth.message.messageId, repository };
    await completeProtocolMessage(auth.credential, auth.message.messageId, response);
    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    if (auth) await releaseProtocolMessage(auth.credential, auth.message.messageId).catch(() => undefined);
    await auditProtocolSecurityFailure(request, securityReason(error)).catch(() => undefined);
    return apiErrorResponse(error, "mission_agent_repository_rejected");
  }
}
