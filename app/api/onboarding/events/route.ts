import { NextResponse } from "next/server";
import { recordOnboardingEvent } from "@/application/onboarding-events";
import { ValidationFailedError } from "@/lib/application-errors";
import { apiErrorResponse } from "@/lib/http-errors";
import { requireApiIdentity, requireMutationOrigin, unauthenticatedResponse } from "@/lib/request-auth";

const allowed = new Set(["onboarding.connection_command_copied"]);
export async function POST(request: Request) {
  const origin = requireMutationOrigin(request);
  if (origin) return origin;
  const identity = await requireApiIdentity();
  if (!identity) return unauthenticatedResponse();
  try {
    const body = (await request.json()) as { eventType?: string; agentId?: string };
    if (!body.eventType || !allowed.has(body.eventType))
      throw new ValidationFailedError("Unsupported onboarding event");
    await recordOnboardingEvent({
      workspaceId: identity.workspaceId,
      actorId: identity.userId,
      eventType: body.eventType,
      payload: { agentId: body.agentId },
    });
    return NextResponse.json({ recorded: true }, { status: 202 });
  } catch (error) {
    return apiErrorResponse(error, "onboarding_event_rejected");
  }
}
