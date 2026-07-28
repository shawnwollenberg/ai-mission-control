import { getDatabasePool } from "@/lib/database";
import { authenticateReplacementBootstrapRequest } from "@/remote-agent/replacement-bootstrap-authenticate";
import {
  ensureGovernedReplacementSmoke,
  evaluateGovernedReplacementSmoke,
} from "@/application/replacement-bootstrap-smoke";
import {
  assertDisposableReplacementDatabase,
  assertDisposableReplacementEnvironment,
} from "@/application/replacement-bootstrap-safety-gate";
import { MISSION_CONTROL_INSTANCE_ID } from "@/integrations/mission-agent/replacement-authorization-package";
import {
  authorizeReplacementSmokePoll,
  recordV1CanonicalPostInstallEvidence,
  recordV1CanonicalRollbackEvidence,
} from "@/application/replacement-bootstrap-governance";
import { assertV1ProductionRouteContext, v1ProductionRoutesEnabled } from "@/application/v1-production-route-gate";
import { executeV1LifecycleHandler, parseV1LifecycleRequest } from "@/application/v1-rollout-lifecycle";

const path = "/api/mission-agent/replacement-bootstrap/decision";

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
    const authenticated = await authenticateReplacementBootstrapRequest(request, path);
    const body = JSON.parse(authenticated.body) as {
      authorizationId?: string;
      executionId?: string;
      authorizationFingerprint?: string;
      claimGeneration?: 1;
      request?: string;
    };
    const environmentClient = await getDatabasePool().connect();
    try {
      if (production) {
        const lifecycleRequest = parseV1LifecycleRequest("decision", body);
        await assertV1ProductionRouteContext({
          client: environmentClient,
          workspaceId: authenticated.credential.workspace_id,
          credentialId: authenticated.credential.credential_id,
          agentId: authenticated.credential.agent_id,
          authorizationId: String(body.authorizationId),
          executionId: String(body.executionId),
          authorizationFingerprint: String(body.authorizationFingerprint),
          allowRecovery: false,
        });
        if (lifecycleRequest.action === "close_rollback") {
          const rollbackEvidence = await recordV1CanonicalRollbackEvidence({
            client: environmentClient,
            workspaceId: authenticated.credential.workspace_id,
            authorizationId: lifecycleRequest.authorizationId,
            executionId: lifecycleRequest.executionId,
          });
          lifecycleRequest.rollbackEvidence = rollbackEvidence.evidence;
          lifecycleRequest.rollbackEvidenceExpiresAt = rollbackEvidence.expiresAt.toISOString();
        }
        const lifecycle = await executeV1LifecycleHandler({
          client: environmentClient,
          handler: "decision",
          request: lifecycleRequest,
          envelope: {
            workspaceId: authenticated.credential.workspace_id,
            credentialId: authenticated.credential.credential_id,
            agentId: authenticated.credential.agent_id,
            requestMessageId: authenticated.headers.messageId,
            requestNonce: authenticated.headers.nonce,
            requestBodyChecksum: authenticated.headers.bodyChecksum,
          },
        });
        const smoke =
          lifecycleRequest.action === "observe_stability"
            ? await ensureGovernedReplacementSmoke({
                workspaceId: authenticated.credential.workspace_id,
                authorizationId: lifecycleRequest.authorizationId,
                replacementExecutionId: lifecycleRequest.executionId,
              })
            : undefined;
        const evaluation =
          lifecycleRequest.action === "evaluate_stability"
            ? await evaluateGovernedReplacementSmoke({
                workspaceId: authenticated.credential.workspace_id,
                authorizationId: lifecycleRequest.authorizationId,
                replacementExecutionId: lifecycleRequest.executionId,
              })
            : undefined;
        if (evaluation?.decision === "continue")
          await recordV1CanonicalPostInstallEvidence({
            client: environmentClient,
            workspaceId: authenticated.credential.workspace_id,
            authorizationId: lifecycleRequest.authorizationId,
            executionId: lifecycleRequest.executionId,
          });
        return Response.json({
          ...lifecycle,
          ...(smoke ? { smoke } : {}),
          ...(evaluation ? { evaluation } : {}),
        });
      }
      await assertDisposableReplacementDatabase(environmentClient);
    } finally {
      environmentClient.release();
    }
    if (body.request !== "smoke-decision") throw new Error("Unsupported replacement decision request.");
    const pollClient = await getDatabasePool().connect();
    try {
      await authorizeReplacementSmokePoll({
        client: pollClient,
        workspaceId: authenticated.credential.workspace_id,
        agentId: authenticated.credential.agent_id,
        credentialId: authenticated.credential.credential_id,
        authorizationId: String(body.authorizationId),
        executionId: String(body.executionId),
        authorizationFingerprint: String(body.authorizationFingerprint),
        claimGeneration: body.claimGeneration ?? 1,
        binding: {
          requestMessageId: authenticated.headers.messageId,
          requestNonce: authenticated.headers.nonce,
          requestBodyChecksum: authenticated.headers.bodyChecksum,
        },
      });
    } finally {
      pollClient.release();
    }
    await ensureGovernedReplacementSmoke({
      workspaceId: authenticated.credential.workspace_id,
      authorizationId: String(body.authorizationId),
      replacementExecutionId: String(body.executionId),
    });
    try {
      const decision = await evaluateGovernedReplacementSmoke({
        workspaceId: authenticated.credential.workspace_id,
        authorizationId: String(body.authorizationId),
        replacementExecutionId: String(body.executionId),
      });
      return Response.json(decision);
    } catch {
      return Response.json({ status: "pending" }, { status: 409 });
    }
  } catch (error) {
    if (process.env.V1_LOCAL_ACCEPTANCE_DIAGNOSTICS === "true")
      console.error("v1-local-decision-rejection", error instanceof Error ? error.message : "unknown");
    return Response.json({ error: "replacement_decision_rejected" }, { status: 403 });
  }
}
