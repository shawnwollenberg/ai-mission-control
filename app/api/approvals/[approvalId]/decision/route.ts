import { NextResponse } from "next/server";
import { resolveApproval } from "@/application/simulated-executor";
import { requireApiIdentity, requireMutationOrigin, unauthenticatedResponse } from "@/lib/request-auth";
import { apiErrorResponse } from "@/lib/http-errors";
export async function POST(request: Request, { params }: { params: Promise<{ approvalId: string }> }) {
  const origin = requireMutationOrigin(request);
  if (origin) return origin;
  const identity = await requireApiIdentity();
  if (!identity) return unauthenticatedResponse();
  try {
    const { approvalId } = await params;
    const body = (await request.json()) as { decision: "grant" | "deny"; reason?: string };
    const applied = await resolveApproval({
      workspaceId: identity.workspaceId,
      approvalId,
      granted: body.decision === "grant",
      decidedBy: identity.userId,
      reason: body.reason ?? "Decision recorded by mission owner",
    });
    return NextResponse.json({ applied });
  } catch (error) {
    return apiErrorResponse(error, "approval_decision_failed");
  }
}
