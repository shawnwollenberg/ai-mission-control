import { NextResponse } from "next/server";
import { handleRequestExecution, handleRequestRemoteExecution } from "@/application/execution-commands";
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
    const body = (await request.json()) as {
      agentId: string;
      repositoryId?: string;
      adapterType?: "codex" | "remote_http";
      timeoutSeconds?: number;
    };
    const shared = {
      actor: { workspaceId: identity.workspaceId, id: identity.userId, type: "human" as const },
      commandId,
      taskId,
      agentId: body.agentId,
      timeoutSeconds: body.timeoutSeconds,
    };
    const result =
      body.adapterType === "remote_http"
        ? await handleRequestRemoteExecution(shared)
        : await handleRequestExecution({ ...shared, repositoryId: body.repositoryId ?? "" });
    return NextResponse.json({ result }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, "execution_request_failed");
  }
}
