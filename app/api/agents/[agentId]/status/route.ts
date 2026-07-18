import { NextResponse } from "next/server";
import { setAgentEnabled } from "@/application/registry";
import { apiErrorResponse } from "@/lib/http-errors";
import { requireApiIdentity, requireMutationOrigin, unauthenticatedResponse } from "@/lib/request-auth";
export async function POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  const origin = requireMutationOrigin(request);
  if (origin) return origin;
  const identity = await requireApiIdentity();
  if (!identity) return unauthenticatedResponse();
  try {
    const { agentId } = await params;
    const body = (await request.json()) as { enabled: boolean };
    return NextResponse.json({ agent: await setAgentEnabled({ actor: identity, agentId, enabled: body.enabled }) });
  } catch (error) {
    return apiErrorResponse(error, "agent_status_failed");
  }
}
