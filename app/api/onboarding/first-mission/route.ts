import { NextResponse } from "next/server";
import { launchFirstRepositoryMission } from "@/application/onboarding-mission";
import { ValidationFailedError } from "@/lib/application-errors";
import { apiErrorResponse } from "@/lib/http-errors";
import {
  readIdempotencyKey,
  requireApiIdentity,
  requireMutationOrigin,
  unauthenticatedResponse,
} from "@/lib/request-auth";

export async function POST(request: Request) {
  const origin = requireMutationOrigin(request);
  if (origin) return origin;
  const identity = await requireApiIdentity();
  if (!identity) return unauthenticatedResponse();
  try {
    const commandId = readIdempotencyKey(request);
    if (!commandId) throw new ValidationFailedError("A UUID idempotency-key header is required");
    const body = (await request.json()) as {
      agentId?: string;
      repositoryId?: string;
      missionType?: "analysis" | "change";
      objective?: string;
      acceptanceCriteria?: string;
      validationInstructions?: string;
    };
    if (!body.agentId || !body.repositoryId) throw new ValidationFailedError("Agent and repository are required");
    const result = await launchFirstRepositoryMission({
      actor: identity,
      commandId,
      agentId: body.agentId,
      repositoryId: body.repositoryId,
      missionType: body.missionType ?? "analysis",
      objective: body.objective,
      acceptanceCriteria: body.acceptanceCriteria,
      validationInstructions: body.validationInstructions,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, "first_mission_launch_failed");
  }
}
