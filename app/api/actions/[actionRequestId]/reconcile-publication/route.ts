import { NextResponse } from "next/server";
import { finalizeMissionAgentPublication } from "@/application/action-executor";
import { apiErrorResponse } from "@/lib/http-errors";
import { requireApiIdentity, requireMutationOrigin, unauthenticatedResponse } from "@/lib/request-auth";

export async function POST(request: Request, { params }: { params: Promise<{ actionRequestId: string }> }) {
  const origin = requireMutationOrigin(request);
  if (origin) return origin;
  const identity = await requireApiIdentity();
  if (!identity) return unauthenticatedResponse();
  try {
    const { actionRequestId } = await params;
    const publication = await finalizeMissionAgentPublication(identity.workspaceId, actionRequestId, identity.userId);
    return NextResponse.json({ publication });
  } catch (error) {
    return apiErrorResponse(error, "publication_reconciliation_failed");
  }
}
