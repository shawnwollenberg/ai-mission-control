import { NextResponse } from "next/server";
import { listAgentCredentials, rotateRemoteAgentCredential } from "@/application/remote-agent-registry";
import { apiErrorResponse } from "@/lib/http-errors";
import { requireApiIdentity, requireMutationOrigin, unauthenticatedResponse } from "@/lib/request-auth";
export async function GET(_: Request, { params }: { params: Promise<{ agentId: string }> }) {
  const identity = await requireApiIdentity();
  if (!identity) return unauthenticatedResponse();
  return NextResponse.json({ credentials: await listAgentCredentials(identity.workspaceId, (await params).agentId) });
}
export async function POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  const origin = requireMutationOrigin(request);
  if (origin) return origin;
  const identity = await requireApiIdentity();
  if (!identity) return unauthenticatedResponse();
  try {
    const body = (await request.json()) as { overlapSeconds?: number; expiresAt?: string };
    const result = await rotateRemoteAgentCredential({
      actor: identity,
      agentId: (await params).agentId,
      overlapSeconds: body.overlapSeconds,
      expiresAt: body.expiresAt,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, "agent_credential_rotation_failed");
  }
}
