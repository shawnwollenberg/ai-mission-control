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
import { authorizeReplacementSmokePoll } from "@/application/replacement-bootstrap-governance";

const path = "/api/mission-agent/replacement-bootstrap/decision";

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
    const environmentClient = await getDatabasePool().connect();
    try {
      await assertDisposableReplacementDatabase(environmentClient);
    } finally {
      environmentClient.release();
    }
    const body = JSON.parse(authenticated.body) as {
      authorizationId?: string;
      executionId?: string;
      authorizationFingerprint?: string;
      claimGeneration?: 1;
      request?: string;
    };
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
  } catch {
    return Response.json({ error: "replacement_decision_rejected" }, { status: 403 });
  }
}
