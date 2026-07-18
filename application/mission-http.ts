import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { handleMissionTransition } from "@/application/mission-commands";
import type { MissionStatus } from "@/domain/mission";
import { ValidationFailedError } from "@/lib/application-errors";
import { apiErrorResponse } from "@/lib/http-errors";
import { getMissionProjection } from "@/lib/mission-queries";
import {
  readIdempotencyKey,
  requireApiIdentity,
  requireMutationOrigin,
  unauthenticatedResponse,
} from "@/lib/request-auth";

export async function handleMissionLifecycleRequest(
  request: Request,
  params: Promise<{ missionId: string }>,
  target: MissionStatus,
) {
  const originError = requireMutationOrigin(request);
  if (originError) return originError;
  const identity = await requireApiIdentity();
  if (!identity) return unauthenticatedResponse();
  const { missionId } = await params;
  const correlationId = randomUUID();
  try {
    const commandId = readIdempotencyKey(request);
    if (!commandId) throw new ValidationFailedError("A UUID idempotency-key header is required");
    const body = (await request.json()) as { expectedVersion?: number };
    if (!Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) < 1) {
      throw new ValidationFailedError("A positive expectedVersion is required");
    }
    const result = await handleMissionTransition({
      actor: { workspaceId: identity.workspaceId, userId: identity.userId, role: identity.role },
      commandId,
      missionId,
      target,
      expectedVersion: body.expectedVersion,
    });
    const projection = await getMissionProjection(identity.workspaceId, missionId);
    return NextResponse.json({ result, projection, correlationId });
  } catch (error) {
    return apiErrorResponse(error, `mission_${target}_failed`);
  }
}
