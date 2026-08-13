import { NextResponse } from "next/server";
import { previewRepositoryIdentityMigration } from "@/application/repository-identity";
import { completeProtocolMessage, releaseProtocolMessage } from "@/application/remote-agent-messages";
import { apiErrorResponse } from "@/lib/http-errors";
import { authenticatePullRequest } from "@/remote-agent/pull-request";
import { auditProtocolSecurityFailure, securityReason } from "@/remote-agent/security";

const path = "/api/agent-protocol/v1/repositories/identity/preview";

export async function POST(request: Request) {
  let auth: Awaited<ReturnType<typeof authenticatePullRequest>> | undefined;
  try {
    auth = await authenticatePullRequest(request, path, "RepositoryIdentityMigrationPreviewed", "repository");
    if (auth.receipt.duplicate) return NextResponse.json(auth.receipt.acknowledgement);
    const payload = auth.message.payload;
    const preview = await previewRepositoryIdentityMigration({
      workspaceId: auth.credential.workspace_id,
      agentId: auth.credential.agent_id,
      repositoryId: String(payload.repositoryId ?? ""),
      registeredPath: String(payload.registeredPath ?? ""),
      currentHead: String(payload.currentHead ?? ""),
      repositoryName: String(payload.repositoryName ?? ""),
      agentLegacyFingerprint: String(payload.legacyFingerprint ?? ""),
      migrationToolVersion: String(payload.migrationToolVersion ?? ""),
      remotes: Array.isArray(payload.remotes)
        ? payload.remotes.map((item) => ({
            name: String((item as Record<string, unknown>).name ?? ""),
            url: String((item as Record<string, unknown>).url ?? ""),
          }))
        : [],
    });
    const response = { protocolVersion: "1.0", messageId: auth.message.messageId, preview };
    await completeProtocolMessage(auth.credential, auth.message.messageId, response);
    return NextResponse.json(response);
  } catch (error) {
    if (auth) await releaseProtocolMessage(auth.credential, auth.message.messageId).catch(() => undefined);
    await auditProtocolSecurityFailure(request, securityReason(error)).catch(() => undefined);
    return apiErrorResponse(error, "repository_identity_preview_rejected");
  }
}
