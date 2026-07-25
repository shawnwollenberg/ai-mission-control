import { NextResponse } from "next/server";
import { getDatabasePool } from "@/lib/database";
import { completeProtocolMessage, releaseProtocolMessage } from "@/application/remote-agent-messages";
import { apiErrorResponse } from "@/lib/http-errors";
import { authenticatePullRequest } from "@/remote-agent/pull-request";
import { auditProtocolSecurityFailure, securityReason } from "@/remote-agent/security";

const path = "/api/agent-protocol/v1/repositories/identity/status";

export async function POST(request: Request) {
  let auth: Awaited<ReturnType<typeof authenticatePullRequest>> | undefined;
  try {
    auth = await authenticatePullRequest(request, path, "RepositoryIdentityMigrationStatusChecked", "repository");
    if (auth.receipt.duplicate) return NextResponse.json(auth.receipt.acknowledgement);
    const payload = auth.message.payload;
    const migration = (
      await getDatabasePool().query(
        `SELECT migration_id,repository_id,status,legacy_fingerprint,stable_fingerprint
         FROM repository_identity_migrations
         WHERE workspace_id=$1 AND migration_id=$2 AND repository_id=$3 AND agent_id=$4`,
        [
          auth.credential.workspace_id,
          String(payload.migrationId ?? ""),
          String(payload.repositoryId ?? ""),
          auth.credential.agent_id,
        ],
      )
    ).rows[0];
    const response = { protocolVersion: "1.0", messageId: auth.message.messageId, migration };
    await completeProtocolMessage(auth.credential, auth.message.messageId, response);
    return NextResponse.json(response);
  } catch (error) {
    if (auth) await releaseProtocolMessage(auth.credential, auth.message.messageId).catch(() => undefined);
    await auditProtocolSecurityFailure(request, securityReason(error)).catch(() => undefined);
    return apiErrorResponse(error, "repository_identity_status_rejected");
  }
}
