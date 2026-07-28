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
import { assertV1ProductionRouteContext, v1ProductionRoutesEnabled } from "@/application/v1-production-route-gate";
import {
  executeV1LifecycleHandler,
  issueGovernedV1OperatorGrant,
  parseV1LifecycleRequest,
} from "@/application/v1-rollout-lifecycle";

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
    const authenticated = await authenticateReplacementBootstrapRequest(request, REPLACEMENT_INTENT_PATH, {
      allowExpiredRecovery: true,
    });
    const client = await getDatabasePool().connect();
    try {
      const body = JSON.parse(authenticated.body);
      if (production) {
        const lifecycleRequest = parseV1LifecycleRequest("intent", body);
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
        const issued =
          lifecycleRequest.action === "propose_grant"
            ? await issueGovernedV1OperatorGrant({
                client,
                credentialId: authenticated.credential.credential_id,
                credentialVerifier: authenticated.credential.secret_verifier,
                request: lifecycleRequest,
                missionControlUrl: process.env.PUBLIC_APP_URL ?? new URL(request.url).origin,
              })
            : undefined;
        const result = await executeV1LifecycleHandler({
          client,
          handler: "intent",
          request: issued?.request ?? lifecycleRequest,
          envelope: {
            workspaceId: authenticated.credential.workspace_id,
            credentialId: authenticated.credential.credential_id,
            agentId: authenticated.credential.agent_id,
            requestMessageId: authenticated.headers.messageId,
            requestNonce: authenticated.headers.nonce,
            requestBodyChecksum: authenticated.headers.bodyChecksum,
          },
        });
        return Response.json({ ...result, ...(issued ? { grant: issued.grant } : {}) });
      }
      await assertDisposableReplacementDatabase(client);
      const result = await createReplacementMutationIntent({
        client,
        workspaceId: authenticated.credential.workspace_id,
        authenticatedCredentialId: authenticated.credential.credential_id,
        authenticatedAgentId: authenticated.credential.agent_id,
        request: body,
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
  } catch (error) {
    if (process.env.V1_LOCAL_ACCEPTANCE_DIAGNOSTICS === "true")
      console.error("v1-local-intent-rejection", error instanceof Error ? error.message : "unknown");
    return Response.json({ error: "replacement_intent_rejected" }, { status: 403 });
  }
}
