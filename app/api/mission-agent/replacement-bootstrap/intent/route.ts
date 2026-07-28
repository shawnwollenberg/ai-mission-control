import { createReplacementMutationIntent } from "@/application/replacement-bootstrap-governance";
import {
  assertDisposableReplacementDatabase,
  assertDisposableReplacementEnvironment,
} from "@/application/replacement-bootstrap-safety-gate";
import { getDatabasePool } from "@/lib/database";
import {
  MISSION_CONTROL_INSTANCE_ID,
  REPLACEMENT_INTENT_PATH,
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
    const authenticated = await authenticateReplacementBootstrapRequest(request, REPLACEMENT_INTENT_PATH, {
      allowExpiredRecovery: true,
    });
    const client = await getDatabasePool().connect();
    try {
      await assertDisposableReplacementDatabase(client);
      const result = await createReplacementMutationIntent({
        client,
        workspaceId: authenticated.credential.workspace_id,
        authenticatedCredentialId: authenticated.credential.credential_id,
        authenticatedAgentId: authenticated.credential.agent_id,
        request: JSON.parse(authenticated.body),
        binding: {
          requestMessageId: authenticated.headers.messageId,
          requestNonce: authenticated.headers.nonce,
          requestBodyChecksum: authenticated.headers.bodyChecksum,
        },
      });
      return Response.json(result);
    } finally {
      client.release();
    }
  } catch {
    return Response.json({ error: "replacement_intent_rejected" }, { status: 403 });
  }
}
