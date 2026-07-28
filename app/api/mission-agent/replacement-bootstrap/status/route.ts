import { readReplacementRecoveryState } from "@/application/replacement-bootstrap-governance";
import {
  assertDisposableReplacementDatabase,
  assertDisposableReplacementEnvironment,
} from "@/application/replacement-bootstrap-safety-gate";
import { getDatabasePool } from "@/lib/database";
import {
  MISSION_CONTROL_INSTANCE_ID,
  REPLACEMENT_STATUS_PATH,
} from "@/integrations/mission-agent/replacement-authorization-package";
import { authenticateReplacementBootstrapRequest } from "@/remote-agent/replacement-bootstrap-authenticate";

export async function POST(request: Request) {
  try {
    assertDisposableReplacementEnvironment({
      environment: process.env,
      databaseUrl: process.env.DATABASE_URL ?? "",
      packageInstanceIdentity: MISSION_CONTROL_INSTANCE_ID,
    });
  } catch {
    return Response.json({ error: "replacement_bootstrap_disabled" }, { status: 503 });
  }
  try {
    const authenticated = await authenticateReplacementBootstrapRequest(request, REPLACEMENT_STATUS_PATH, {
      allowExpiredRecovery: true,
    });
    const body = JSON.parse(authenticated.body);
    const client = await getDatabasePool().connect();
    try {
      await assertDisposableReplacementDatabase(client);
      return Response.json(
        await readReplacementRecoveryState({
          client,
          workspaceId: authenticated.credential.workspace_id,
          agentId: authenticated.credential.agent_id,
          credentialId: authenticated.credential.credential_id,
          authorizationId: body.authorizationId,
          executionId: body.executionId,
          authorizationFingerprint: body.authorizationFingerprint,
          claimGeneration: body.claimGeneration,
          binding: {
            requestMessageId: authenticated.headers.messageId,
            requestNonce: authenticated.headers.nonce,
            requestBodyChecksum: authenticated.headers.bodyChecksum,
          },
        }),
      );
    } finally {
      client.release();
    }
  } catch {
    return Response.json({ error: "replacement_status_rejected" }, { status: 403 });
  }
}
