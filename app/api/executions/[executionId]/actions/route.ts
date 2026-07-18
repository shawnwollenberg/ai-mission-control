import { NextResponse } from "next/server";
import { requestSensitiveAction } from "@/application/action-commands";
import { apiErrorResponse } from "@/lib/http-errors";
import {
  readIdempotencyKey,
  requireApiIdentity,
  requireMutationOrigin,
  unauthenticatedResponse,
} from "@/lib/request-auth";

export async function POST(request: Request, { params }: { params: Promise<{ executionId: string }> }) {
  const origin = requireMutationOrigin(request);
  if (origin) return origin;
  const identity = await requireApiIdentity();
  if (!identity) return unauthenticatedResponse();
  try {
    const { executionId } = await params;
    const body = (await request.json()) as {
      actionType: "repository.push_branch" | "repository.create_pull_request";
      parameters: Record<string, unknown>;
      targetResource: string;
    };
    const result = await requestSensitiveAction({
      actor: { workspaceId: identity.workspaceId, id: identity.userId, type: "human", role: identity.role },
      commandId: readIdempotencyKey(request) ?? crypto.randomUUID(),
      executionId,
      actionType: body.actionType,
      parameters: body.parameters,
      targetResource: body.targetResource,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, "action_request_failed");
  }
}
