import { NextResponse } from "next/server";
import { changeRecommendationStatus } from "@/application/recommendation-commands";
import { apiErrorResponse } from "@/lib/http-errors";
import { requireApiIdentity, requireMutationOrigin, unauthenticatedResponse } from "@/lib/request-auth";
export async function POST(request: Request, { params }: { params: Promise<{ recommendationId: string }> }) {
  const origin = requireMutationOrigin(request);
  if (origin) return origin;
  const identity = await requireApiIdentity();
  if (!identity) return unauthenticatedResponse();
  try {
    const { recommendationId } = await params;
    const body = await request.json();
    const allowed = ["accepted", "completed", "stale", "dismissed"];
    if (!allowed.includes(body.status))
      return NextResponse.json({ error: { message: "Unsupported recommendation status" } }, { status: 400 });
    await changeRecommendationStatus({
      actor: { workspaceId: identity.workspaceId, id: identity.userId, type: "human" },
      commandId: request.headers.get("idempotency-key") ?? crypto.randomUUID(),
      recommendationId,
      target: body.status,
      reason: String(body.reason ?? "").slice(0, 500),
    });
    return NextResponse.json({ status: body.status });
  } catch (error) {
    return apiErrorResponse(error, "recommendation_status_failed");
  }
}
