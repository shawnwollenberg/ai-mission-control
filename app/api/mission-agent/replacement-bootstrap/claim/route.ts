import {
  confirmReplacementPackageClaim,
  establishAuthoritativeReplacementDrain,
} from "@/application/replacement-bootstrap-governance";
import { getDatabasePool } from "@/lib/database";
import { authenticateReplacementBootstrapRequest } from "@/remote-agent/replacement-bootstrap-authenticate";
import {
  assertDisposableReplacementDatabase,
  assertDisposableReplacementEnvironment,
} from "@/application/replacement-bootstrap-safety-gate";
import { MISSION_CONTROL_INSTANCE_ID } from "@/integrations/mission-agent/replacement-authorization-package";

const path = "/api/mission-agent/replacement-bootstrap/claim";

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
    const authenticated = await authenticateReplacementBootstrapRequest(request, path);
    const client = await getDatabasePool().connect();
    try {
      await assertDisposableReplacementDatabase(client);
      const body = JSON.parse(authenticated.body);
      const result = await confirmReplacementPackageClaim({
        client,
        workspaceId: authenticated.credential.workspace_id,
        agentId: authenticated.credential.agent_id,
        credentialId: authenticated.credential.credential_id,
        requestMessageId: authenticated.headers.messageId,
        requestNonce: authenticated.headers.nonce,
        requestBodyChecksum: authenticated.headers.bodyChecksum,
        body,
      });
      const drain = await establishAuthoritativeReplacementDrain({
        client,
        workspaceId: authenticated.credential.workspace_id,
        authorizationId: body.authorizationId,
        executionId: body.executionId,
        agentId: authenticated.credential.agent_id,
      });
      return Response.json({ ...result, ...drain });
    } finally {
      client.release();
    }
  } catch {
    return Response.json({ error: "replacement_claim_rejected" }, { status: 403 });
  }
}
