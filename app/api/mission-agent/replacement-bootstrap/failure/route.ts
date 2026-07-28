import { requireReplacementRollback } from "@/application/replacement-bootstrap-governance";
import {
  assertDisposableReplacementDatabase,
  assertDisposableReplacementEnvironment,
} from "@/application/replacement-bootstrap-safety-gate";
import { getDatabasePool } from "@/lib/database";
import {
  MISSION_CONTROL_INSTANCE_ID,
  REPLACEMENT_FAILURE_PATH,
} from "@/integrations/mission-agent/replacement-authorization-package";
import { authenticateReplacementBootstrapRequest } from "@/remote-agent/replacement-bootstrap-authenticate";
import { assertV1ProductionRouteContext, v1ProductionRoutesEnabled } from "@/application/v1-production-route-gate";
import { executeV1LifecycleHandler, parseV1LifecycleRequest } from "@/application/v1-rollout-lifecycle";

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
    const authenticated = await authenticateReplacementBootstrapRequest(request, REPLACEMENT_FAILURE_PATH, {
      allowExpiredRecovery: true,
    });
    const body = JSON.parse(authenticated.body);
    const client = await getDatabasePool().connect();
    try {
      if (production) {
        const lifecycleRequest = parseV1LifecycleRequest("failure", body);
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
            handler: "failure",
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
      return Response.json(
        await requireReplacementRollback({
          client,
          workspaceId: authenticated.credential.workspace_id,
          agentId: authenticated.credential.agent_id,
          credentialId: authenticated.credential.credential_id,
          authorizationId: body.authorizationId,
          executionId: body.executionId,
          authorizationFingerprint: body.authorizationFingerprint,
          claimGeneration: body.claimGeneration,
          failureChecksum: body.failureChecksum,
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
  } catch (error) {
    if (process.env.V1_LOCAL_ACCEPTANCE_DIAGNOSTICS === "true")
      console.error("v1-local-failure-rejection", error instanceof Error ? error.message : "unknown");
    return Response.json({ error: "replacement_rollback_rejected" }, { status: 403 });
  }
}
