import { NextResponse } from "next/server";
import { handleRequestExecution } from "@/application/execution-commands";
import { apiErrorResponse } from "@/lib/http-errors";
import {
  readIdempotencyKey,
  requireApiIdentity,
  requireMutationOrigin,
  unauthenticatedResponse,
} from "@/lib/request-auth";
import { ValidationFailedError } from "@/lib/application-errors";
export async function POST(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const origin = requireMutationOrigin(request);
  if (origin) return origin;
  const identity = await requireApiIdentity();
  if (!identity) return unauthenticatedResponse();
  try {
    const commandId = readIdempotencyKey(request);
    if (!commandId) throw new ValidationFailedError("A UUID idempotency-key header is required");
    const { taskId } = await params;
    const body = (await request.json()) as { agentId: string; repositoryId: string; timeoutSeconds?: number };
    const result = await handleRequestExecution({
      actor: { workspaceId: identity.workspaceId, id: identity.userId, type: "human" },
      commandId,
      taskId,
      agentId: body.agentId,
      repositoryId: body.repositoryId,
      timeoutSeconds: body.timeoutSeconds,
    });
    return NextResponse.json({ result }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, "execution_request_failed");
  }
}
