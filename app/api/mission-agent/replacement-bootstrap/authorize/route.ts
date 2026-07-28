import { randomUUID } from "node:crypto";
import { issueV1ProductionReplacementCredentialAndClaim } from "@/application/replacement-bootstrap-governance";
import { loadReplacementBootstrap } from "@/application/mission-agent-replacement-bootstrap";
import { v1ProductionRoutesEnabled } from "@/application/v1-production-route-gate";
import { getDatabasePool } from "@/lib/database";
import { requireApiIdentity, requireMutationOrigin, unauthenticatedResponse } from "@/lib/request-auth";

export async function POST(request: Request) {
  if (!v1ProductionRoutesEnabled()) return Response.json({ error: "replacement_bootstrap_disabled" }, { status: 503 });
  const identity = await requireApiIdentity();
  if (!identity) return unauthenticatedResponse();
  const originFailure = requireMutationOrigin(request);
  if (originFailure) return originFailure;
  if (identity.role !== "owner") return Response.json({ error: "replacement_authorization_rejected" }, { status: 403 });
  try {
    const body = JSON.parse(await request.text()) as {
      authorizationId: string;
      deploymentId: string;
      configurationId: string;
    };
    if (Object.keys(body).sort().join(",") !== ["authorizationId", "configurationId", "deploymentId"].join(","))
      throw new Error("V1 authorization body has missing or unknown fields.");
    const client = await getDatabasePool().connect();
    try {
      const record = await loadReplacementBootstrap(client, identity.workspaceId, body.authorizationId);
      if (
        !record ||
        record.state !== "approved" ||
        ![identity.userId, identity.email].includes(record.authorization.approvedBy)
      )
        throw new Error("The authenticated owner is not the recorded replacement approver.");
      return Response.json(
        await issueV1ProductionReplacementCredentialAndClaim({
          client,
          authorization: record.authorization,
          executionId: randomUUID(),
          authenticatedApprover: record.authorization.approvedBy,
          deploymentId: body.deploymentId,
          configurationId: body.configurationId,
        }),
        { status: 201 },
      );
    } finally {
      client.release();
    }
  } catch {
    return Response.json({ error: "replacement_authorization_rejected" }, { status: 403 });
  }
}
