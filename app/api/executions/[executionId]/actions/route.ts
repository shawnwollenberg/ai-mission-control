import { NextResponse } from "next/server";
import { requestPublishForReview, requestSensitiveAction } from "@/application/action-commands";
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
      actionType: "repository.push_branch" | "repository.create_pull_request" | "repository.publish_for_review";
      parameters: Record<string, unknown>;
      targetResource: string;
    };
    const actor = {
      workspaceId: identity.workspaceId,
      id: identity.userId,
      type: "human" as const,
      role: identity.role,
    };
    const result =
      body.actionType === "repository.publish_for_review"
        ? await requestPublishForReview({
            actor,
            commandId: readIdempotencyKey(request) ?? crypto.randomUUID(),
            executionId,
          })
        : await requestSensitiveAction({
            actor,
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
