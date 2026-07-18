import { NextResponse } from "next/server";
import { handleCreateMission } from "@/application/mission-commands";
import { ValidationFailedError } from "@/lib/application-errors";
import { apiErrorResponse } from "@/lib/http-errors";
import { getMissionProjection, listMissionsForWorkspace } from "@/lib/mission-queries";
import {
  readIdempotencyKey,
  requireApiIdentity,
  requireMutationOrigin,
  unauthenticatedResponse,
} from "@/lib/request-auth";

type CreateMissionBody = {
  name?: string;
  objective?: string;
  description?: string;
  domain?: string;
  priority?: "high" | "normal" | "low";
  riskLevel?: "unknown" | "low" | "moderate" | "high";
  successCriteria?: string[];
  constraints?: string[];
  deadline?: string;
  budgetLimits?: Record<string, number>;
};

export async function GET() {
  const identity = await requireApiIdentity();
  if (!identity) return unauthenticatedResponse();
  try {
    return NextResponse.json({ missions: await listMissionsForWorkspace(identity.workspaceId) });
  } catch (error) {
    return apiErrorResponse(error, "mission_list_failed");
  }
}

export async function POST(request: Request) {
  const originError = requireMutationOrigin(request);
  if (originError) return originError;
  const identity = await requireApiIdentity();
  if (!identity) return unauthenticatedResponse();
  try {
    const commandId = readIdempotencyKey(request);
    if (!commandId) throw new ValidationFailedError("A UUID idempotency-key header is required");
    const body = (await request.json()) as CreateMissionBody;
    if (!body.name?.trim() || !body.objective?.trim()) {
      throw new ValidationFailedError("Mission name and objective are required");
    }
    const priorities = ["high", "normal", "low"];
    const risks = ["unknown", "low", "moderate", "high"];
    if (body.priority && !priorities.includes(body.priority))
      throw new ValidationFailedError("Invalid mission priority");
    if (body.riskLevel && !risks.includes(body.riskLevel))
      throw new ValidationFailedError("Invalid mission risk level");
    if (body.successCriteria && !body.successCriteria.every((value) => typeof value === "string")) {
      throw new ValidationFailedError("Success criteria must be strings");
    }
    if (body.constraints && !body.constraints.every((value) => typeof value === "string")) {
      throw new ValidationFailedError("Constraints must be strings");
    }
    const result = await handleCreateMission({
      actor: {
        workspaceId: identity.workspaceId,
        userId: identity.userId,
        role: identity.role,
      },
      commandId,
      mission: {
        name: body.name,
        objective: body.objective,
        description: body.description,
        domain: body.domain?.trim() || "software_delivery",
        priority: body.priority ?? "normal",
        riskLevel: body.riskLevel ?? "unknown",
        successCriteria: body.successCriteria,
        constraints: body.constraints,
        deadline: body.deadline,
        budgetLimits: body.budgetLimits,
      },
    });
    const projection = await getMissionProjection(identity.workspaceId, result.missionId);
    return NextResponse.json(
      { missionId: result.missionId, aggregateVersion: result.aggregateVersion, projection },
      { status: result.duplicateCommand ? 200 : 201 },
    );
  } catch (error) {
    return apiErrorResponse(error, "mission_create_failed");
  }
}
