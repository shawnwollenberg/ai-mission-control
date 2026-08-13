import { NextResponse } from "next/server";
import { createConsensusImplementationMission } from "@/application/consensus-plan-commands";
import { ValidationFailedError } from "@/lib/application-errors";
import { apiErrorResponse } from "@/lib/http-errors";
import {
  readIdempotencyKey,
  requireApiIdentity,
  requireMutationOrigin,
  unauthenticatedResponse,
} from "@/lib/request-auth";

export async function POST(request: Request, { params }: { params: Promise<{ missionId: string }> }) {
  const origin = requireMutationOrigin(request);
  if (origin) return origin;
  const identity = await requireApiIdentity();
  if (!identity) return unauthenticatedResponse();
  try {
    const commandId = readIdempotencyKey(request);
    if (!commandId) throw new ValidationFailedError("A UUID idempotency-key header is required");
    const { missionId } = await params;
    const body = (await request.json()) as {
      executorAgentId?: string;
      executorModelId?: string;
    };
    if (!body.executorModelId) throw new ValidationFailedError("Select an executor model");
    const result = await createConsensusImplementationMission({
      actor: identity,
      commandId,
      consensusMissionId: missionId,
      executorAgentId: body.executorAgentId,
      executorModelId: body.executorModelId,
    });
    return NextResponse.json(result, { status: result.duplicate ? 200 : 201 });
  } catch (error) {
    return apiErrorResponse(error, "consensus_implementation_mission_create_failed");
  }
}
