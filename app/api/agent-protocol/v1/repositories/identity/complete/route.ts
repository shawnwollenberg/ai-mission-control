import { NextResponse } from "next/server";
import { prepareRepositoryIdentityActivation } from "@/application/repository-identity";
import { completeProtocolMessage, releaseProtocolMessage } from "@/application/remote-agent-messages";
import { apiErrorResponse } from "@/lib/http-errors";
import { authenticatePullRequest } from "@/remote-agent/pull-request";
import { auditProtocolSecurityFailure, securityReason } from "@/remote-agent/security";

const path = "/api/agent-protocol/v1/repositories/identity/complete";

export async function POST(request: Request) {
  let auth: Awaited<ReturnType<typeof authenticatePullRequest>> | undefined;
  try {
    auth = await authenticatePullRequest(request, path, "RepositoryIdentityActivationRequested", "repository");
    if (auth.receipt.duplicate) return NextResponse.json(auth.receipt.acknowledgement);
    const payload = auth.message.payload;
    const result = await prepareRepositoryIdentityActivation({
      workspaceId: auth.credential.workspace_id,
      agentId: auth.credential.agent_id,
      migrationId: String(payload.migrationId ?? ""),
      requestFingerprint: String(payload.requestFingerprint ?? ""),
      stableFingerprint: String(payload.stableFingerprint ?? ""),
      registeredPath: String(payload.registeredPath ?? ""),
      currentHead: String(payload.currentHead ?? ""),
      signingKey: auth.credential.secret_verifier,
    });
    const response = { protocolVersion: "1.0", messageId: auth.message.messageId, ...result };
    await completeProtocolMessage(auth.credential, auth.message.messageId, response);
    return NextResponse.json(response);
  } catch (error) {
    if (auth) await releaseProtocolMessage(auth.credential, auth.message.messageId).catch(() => undefined);
    await auditProtocolSecurityFailure(request, securityReason(error)).catch(() => undefined);
    return apiErrorResponse(error, "repository_identity_migration_rejected");
  }
}
