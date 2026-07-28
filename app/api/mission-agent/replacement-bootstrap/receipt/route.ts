import { consumeGovernedReplacementReceipt } from "@/application/replacement-bootstrap-governance";
import type { LocalOperationReceipt } from "@/application/replacement-bootstrap-local-operator";
import { getDatabasePool } from "@/lib/database";
import { authenticateReplacementBootstrapRequest } from "@/remote-agent/replacement-bootstrap-authenticate";
import {
  assertDisposableReplacementDatabase,
  assertDisposableReplacementEnvironment,
} from "@/application/replacement-bootstrap-safety-gate";
import { MISSION_CONTROL_INSTANCE_ID } from "@/integrations/mission-agent/replacement-authorization-package";
import { assertV1ProductionRouteContext, v1ProductionRoutesEnabled } from "@/application/v1-production-route-gate";
import { executeV1LifecycleHandler, parseV1LifecycleRequest } from "@/application/v1-rollout-lifecycle";

const path = "/api/mission-agent/replacement-bootstrap/receipt";

export async function POST(request: Request) {
  const production = v1ProductionRoutesEnabled();
  try {
    if (!production)
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
      if (production) {
        const lifecycleRequest = parseV1LifecycleRequest("receipt", body);
        await assertV1ProductionRouteContext({
          client,
          workspaceId: authenticated.credential.workspace_id,
          credentialId: authenticated.credential.credential_id,
          agentId: authenticated.credential.agent_id,
          authorizationId: body.authorizationId,
          executionId: body.executionId,
          authorizationFingerprint: body.authorizationFingerprint,
          allowRecovery: true,
        });
        return Response.json(
          await executeV1LifecycleHandler({
            client,
            handler: "receipt",
            request: lifecycleRequest,
            envelope: {
              workspaceId: authenticated.credential.workspace_id,
              credentialId: authenticated.credential.credential_id,
              agentId: authenticated.credential.agent_id,
              requestMessageId: authenticated.headers.messageId,
              requestNonce: authenticated.headers.nonce,
              requestBodyChecksum: authenticated.headers.bodyChecksum,
            },
          }),
        );
      }
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
  } catch (error) {
    if (process.env.V1_LOCAL_ACCEPTANCE_DIAGNOSTICS === "true")
      console.error("v1-local-receipt-rejection", error instanceof Error ? error.message : "unknown");
    return Response.json({ error: "replacement_receipt_rejected" }, { status: 403 });
  }
}
