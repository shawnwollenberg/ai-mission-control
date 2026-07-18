import { NextResponse } from "next/server";
import { handleExecutionCancellation } from "@/application/execution-commands";
import { apiErrorResponse } from "@/lib/http-errors";
import {
  readIdempotencyKey,
  requireApiIdentity,
  requireMutationOrigin,
  unauthenticatedResponse,
} from "@/lib/request-auth";
import { ValidationFailedError } from "@/lib/application-errors";
export async function POST(request: Request, { params }: { params: Promise<{ executionId: string }> }) {
  const origin = requireMutationOrigin(request);
  if (origin) return origin;
  const identity = await requireApiIdentity();
  if (!identity) return unauthenticatedResponse();
  try {
    const commandId = readIdempotencyKey(request);
    if (!commandId) throw new ValidationFailedError("A UUID idempotency-key header is required");
    const { executionId } = await params;
    return NextResponse.json({
      result: await handleExecutionCancellation({
        actor: { workspaceId: identity.workspaceId, id: identity.userId, type: "human" },
        commandId,
        executionId,
      }),
    });
  } catch (error) {
    return apiErrorResponse(error, "execution_cancellation_failed");
  }
}
