import { NextResponse } from "next/server";
import {
  configureDisposableRepositoryAuthority,
  configureProductionReadOnlyPlanningAuthority,
  removeMissionAgentRepositoryAssociation,
  setRepositoryEnabled,
} from "@/application/registry";
import { randomUUID } from "node:crypto";
import { apiErrorResponse } from "@/lib/http-errors";
import { requireApiIdentity, requireMutationOrigin, unauthenticatedResponse } from "@/lib/request-auth";

export async function PATCH(request: Request, context: { params: Promise<{ agentId: string; repositoryId: string }> }) {
  const identity = await requireApiIdentity();
  if (!identity) return unauthenticatedResponse();
  try {
    const originError = requireMutationOrigin(request);
    if (originError) return originError;
    const { agentId, repositoryId } = await context.params;
    const body = await request.json();
    if (body.authorityProfile === "disposable_local_implementation/1") {
      return NextResponse.json({
        repository: await configureDisposableRepositoryAuthority({
          actor: identity,
          commandId: String(body.commandId ?? randomUUID()),
          repositoryId,
          implementationAgentIds: Array.isArray(body.implementationAgentIds)
            ? body.implementationAgentIds.map(String)
            : [agentId],
          validationCommands: Array.isArray(body.validationCommands) ? body.validationCommands : undefined,
        }),
      });
    }
    if (body.authorityProfile === "production_read_only_planning/1") {
      return NextResponse.json({
        repository: await configureProductionReadOnlyPlanningAuthority({
          actor: identity,
          commandId: String(body.commandId ?? randomUUID()),
          repositoryId,
          planningAgentIds: Array.isArray(body.planningAgentIds) ? body.planningAgentIds.map(String) : [agentId],
          validationCommands: Array.isArray(body.validationCommands) ? body.validationCommands : [],
        }),
      });
    }
    return NextResponse.json({
      repository: await setRepositoryEnabled({
        actor: identity,
        agentId,
        repositoryId,
        enabled: Boolean(body.enabled),
      }),
    });
  } catch (error) {
    return apiErrorResponse(error, "repository_status_update_failed");
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ agentId: string; repositoryId: string }> },
) {
  const identity = await requireApiIdentity();
  if (!identity) return unauthenticatedResponse();
  try {
    const originError = requireMutationOrigin(request);
    if (originError) return originError;
    if (identity.role !== "owner") throw new Error("Workspace owner permission is required");
    const { agentId, repositoryId } = await context.params;
    return NextResponse.json({
      repository: await removeMissionAgentRepositoryAssociation({
        workspaceId: identity.workspaceId,
        agentId,
        repositoryId,
      }),
    });
  } catch (error) {
    return apiErrorResponse(error, "repository_association_removal_failed");
  }
}
