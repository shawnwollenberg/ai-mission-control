import { NextResponse } from "next/server";
import { createConsensusPlanMission } from "@/application/consensus-plan-commands";
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
      repositoryId?: string;
      baseBranch?: string;
      objective?: string;
      acceptanceCriteria?: string[];
      constraints?: string[];
      plannerA?: { agentId?: string; modelId?: string };
      plannerB?: { agentId?: string; modelId?: string };
      synthesizer?: { agentId?: string; modelId?: string };
      preferredExecutorAgentId?: string;
      preferredExecutorModelId?: string;
      implementationReviewer?: { agentId?: string; modelId?: string };
      requireImplementationReview?: boolean;
      maximumCostAmount?: number;
      costCurrency?: string;
      maximumDurationSeconds?: number;
    };
    if (
      !body.repositoryId ||
      !body.objective ||
      !body.plannerA?.agentId ||
      !body.plannerA.modelId ||
      !body.plannerB?.agentId ||
      !body.plannerB.modelId ||
      !body.synthesizer?.agentId ||
      !body.synthesizer.modelId ||
      !body.preferredExecutorAgentId ||
      !body.preferredExecutorModelId
    )
      throw new ValidationFailedError(
        "Repository, objective, planner A, planner B, synthesizer, and executor agent/model assignments are required",
      );
    const result = await createConsensusPlanMission({
      actor: identity,
      commandId,
      repositoryId: body.repositoryId,
      baseBranch: body.baseBranch,
      objective: body.objective,
      acceptanceCriteria: body.acceptanceCriteria ?? [],
      constraints: body.constraints,
      plannerA: { agentId: body.plannerA.agentId, modelId: body.plannerA.modelId },
      plannerB: { agentId: body.plannerB.agentId, modelId: body.plannerB.modelId },
      synthesizer: { agentId: body.synthesizer.agentId, modelId: body.synthesizer.modelId },
      preferredExecutorAgentId: body.preferredExecutorAgentId,
      preferredExecutorModelId: body.preferredExecutorModelId,
      implementationReviewer:
        body.implementationReviewer?.agentId && body.implementationReviewer.modelId
          ? { agentId: body.implementationReviewer.agentId, modelId: body.implementationReviewer.modelId }
          : undefined,
      requireImplementationReview: body.requireImplementationReview,
      maximumCostAmount: body.maximumCostAmount,
      costCurrency: body.costCurrency,
      maximumDurationSeconds: body.maximumDurationSeconds,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, "consensus_plan_create_failed");
  }
}
