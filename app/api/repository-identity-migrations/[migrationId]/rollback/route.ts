import { NextResponse } from "next/server";
import { rollbackRepositoryIdentityMigration } from "@/application/repository-identity";
import { apiErrorResponse } from "@/lib/http-errors";
import { requireApiIdentity, requireMutationOrigin, unauthenticatedResponse } from "@/lib/request-auth";

export async function POST(request: Request, { params }: { params: Promise<{ migrationId: string }> }) {
  const identity = await requireApiIdentity();
  if (!identity) return unauthenticatedResponse();
  try {
    const originError = requireMutationOrigin(request);
    if (originError) return originError;
    if (identity.role !== "owner")
      return NextResponse.json({ error: { message: "Workspace owner permission is required" } }, { status: 403 });
    const result = await rollbackRepositoryIdentityMigration({
      workspaceId: identity.workspaceId,
      migrationId: (await params).migrationId,
      actorId: identity.userId,
    });
    return NextResponse.json(result);
  } catch (error) {
    return apiErrorResponse(error, "repository_identity_rollback_failed");
  }
}
