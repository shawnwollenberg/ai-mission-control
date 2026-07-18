import { NextResponse } from "next/server";
import { revokeRemoteAgentCredential } from "@/application/remote-agent-registry";
import { apiErrorResponse } from "@/lib/http-errors";
import { requireApiIdentity, requireMutationOrigin, unauthenticatedResponse } from "@/lib/request-auth";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ agentId: string; credentialId: string }> },
) {
  const origin = requireMutationOrigin(request);
  if (origin) return origin;
  const identity = await requireApiIdentity();
  if (!identity) return unauthenticatedResponse();
  try {
    const body = (await request.json().catch(() => ({}))) as { emergency?: boolean };
    const ids = await params;
    return NextResponse.json(
      await revokeRemoteAgentCredential({
        actor: identity,
        agentId: ids.agentId,
        credentialId: ids.credentialId,
        emergency: body.emergency,
      }),
    );
  } catch (error) {
    return apiErrorResponse(error, "agent_credential_revocation_failed");
  }
}
