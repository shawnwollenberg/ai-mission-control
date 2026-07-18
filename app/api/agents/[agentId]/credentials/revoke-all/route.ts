import { NextResponse } from "next/server";
import { revokeRemoteAgentCredential } from "@/application/remote-agent-registry";
import { apiErrorResponse } from "@/lib/http-errors";
import { requireApiIdentity, requireMutationOrigin, unauthenticatedResponse } from "@/lib/request-auth";
export async function POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  const origin = requireMutationOrigin(request);
  if (origin) return origin;
  const identity = await requireApiIdentity();
  if (!identity) return unauthenticatedResponse();
  try {
    return NextResponse.json(
      await revokeRemoteAgentCredential({
        actor: identity,
        agentId: (await params).agentId,
        revokeAll: true,
        emergency: true,
      }),
    );
  } catch (error) {
    return apiErrorResponse(error, "agent_credentials_revoke_all_failed");
  }
}
