import { NextResponse } from "next/server";
import { removeMissionAgentRepositoryAssociation, setRepositoryEnabled } from "@/application/registry";
import { apiErrorResponse } from "@/lib/http-errors";
import { requireApiIdentity, requireMutationOrigin, unauthenticatedResponse } from "@/lib/request-auth";

export async function PATCH(request: Request, context: { params: Promise<{ agentId: string; repositoryId: string }> }) {
  const identity = await requireApiIdentity();
  if (!identity) return unauthenticatedResponse();
  try {
    requireMutationOrigin(request);
    const { agentId, repositoryId } = await context.params;
    const body = await request.json();
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
    requireMutationOrigin(request);
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
