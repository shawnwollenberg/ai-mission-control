import { NextResponse } from "next/server";
import { listAgents, registerAgent } from "@/application/registry";
import { apiErrorResponse } from "@/lib/http-errors";
import { requireApiIdentity, requireMutationOrigin, unauthenticatedResponse } from "@/lib/request-auth";
export async function GET() {
  const identity = await requireApiIdentity();
  if (!identity) return unauthenticatedResponse();
  return NextResponse.json({ agents: await listAgents(identity.workspaceId) });
}
export async function POST(request: Request) {
  const origin = requireMutationOrigin(request);
  if (origin) return origin;
  const identity = await requireApiIdentity();
  if (!identity) return unauthenticatedResponse();
  try {
    const body = (await request.json()) as {
      name: string;
      description?: string;
      capabilities?: string[];
      supportedDomains?: string[];
      concurrencyLimit?: number;
      runtimeConfigurationReference?: string;
      credentialReference?: string;
    };
    const agent = await registerAgent({
      actor: identity,
      name: body.name,
      description: body.description,
      adapterType: "codex",
      capabilities: body.capabilities ?? [
        "repository.read",
        "repository.write",
        "code.implement",
        "test.run",
        "artifact.create",
        "git.commit",
      ],
      supportedDomains: body.supportedDomains ?? ["software_delivery"],
      trustLevel: "controlled",
      concurrencyLimit: body.concurrencyLimit,
      runtimeConfigurationReference: body.runtimeConfigurationReference,
      credentialReference: body.credentialReference,
    });
    return NextResponse.json({ agent }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, "agent_registration_failed");
  }
}
