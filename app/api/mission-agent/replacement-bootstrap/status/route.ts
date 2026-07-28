import { readReplacementRecoveryState } from "@/application/replacement-bootstrap-governance";
import { executeV1LifecycleHandler, parseV1LifecycleRequest } from "@/application/v1-rollout-lifecycle";
import { assertV1ProductionRouteContext } from "@/application/v1-production-route-gate";
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
  if (process.env.MISSION_CONTROL_V1_PRODUCTION_ROUTES_ENABLED === "true") {
    try {
      const authenticated = await authenticateReplacementBootstrapRequest(request, REPLACEMENT_STATUS_PATH, {
        allowExpiredRecovery: true,
      });
      const body = JSON.parse(authenticated.body);
      const lifecycleRequest = parseV1LifecycleRequest("status", body);
      const client = await getDatabasePool().connect();
      try {
        await assertV1ProductionRouteContext({
          client,
          workspaceId: authenticated.credential.workspace_id,
          credentialId: authenticated.credential.credential_id,
          agentId: authenticated.credential.agent_id,
          authorizationId: lifecycleRequest.authorizationId,
          executionId: lifecycleRequest.executionId,
          authorizationFingerprint: lifecycleRequest.authorizationFingerprint,
          allowRecovery: true,
        });
        return Response.json(
          await executeV1LifecycleHandler({
            client,
            handler: "status",
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
      } finally {
        client.release();
      }
    } catch (error) {
      if (process.env.V1_LOCAL_ACCEPTANCE_DIAGNOSTICS === "true")
        console.error("v1-local-status-rejection", error instanceof Error ? error.message : "unknown");
      return Response.json(
        {
          error: "replacement_status_rejected",
          ...(process.env.V1_LOCAL_ACCEPTANCE_DIAGNOSTICS === "true" && error instanceof Error
            ? { diagnostic: error.message }
            : {}),
        },
        { status: 403 },
      );
    }
  }
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
  } catch (error) {
    if (process.env.V1_LOCAL_ACCEPTANCE_DIAGNOSTICS === "true")
      console.error("v1-local-status-rejection", error instanceof Error ? error.message : "unknown");
    return Response.json(
      {
        error: "replacement_status_rejected",
        ...(process.env.V1_LOCAL_ACCEPTANCE_DIAGNOSTICS === "true" && error instanceof Error
          ? { diagnostic: error.message }
          : {}),
      },
      { status: 403 },
    );
  }
}
