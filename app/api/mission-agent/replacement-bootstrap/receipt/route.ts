import { consumeGovernedReplacementReceipt } from "@/application/replacement-bootstrap-governance";
import type { LocalOperationReceipt } from "@/application/replacement-bootstrap-local-operator";
import { getDatabasePool } from "@/lib/database";
import { authenticateReplacementBootstrapRequest } from "@/remote-agent/replacement-bootstrap-authenticate";
import {
  assertDisposableReplacementDatabase,
  assertDisposableReplacementEnvironment,
} from "@/application/replacement-bootstrap-safety-gate";
import { MISSION_CONTROL_INSTANCE_ID } from "@/integrations/mission-agent/replacement-authorization-package";

const path = "/api/mission-agent/replacement-bootstrap/receipt";

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
    const authenticated = await authenticateReplacementBootstrapRequest(request, path, {
      allowExpiredRecovery: true,
    });
    const body = JSON.parse(authenticated.body) as LocalOperationReceipt;
    const client = await getDatabasePool().connect();
    try {
      await assertDisposableReplacementDatabase(client);
      const result = await consumeGovernedReplacementReceipt({
        client,
        workspaceId: authenticated.credential.workspace_id,
        credentialId: authenticated.credential.credential_id,
        requestMessageId: authenticated.headers.messageId,
        requestNonce: authenticated.headers.nonce,
        requestBodyChecksum: authenticated.headers.bodyChecksum,
        receipt: body,
      });
      return Response.json(result);
    } finally {
      client.release();
    }
  } catch {
    return Response.json({ error: "replacement_receipt_rejected" }, { status: 403 });
  }
}
