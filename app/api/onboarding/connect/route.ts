import { NextResponse } from "next/server";
import { registerRemoteAgent } from "@/application/remote-agent-registry";
import { apiErrorResponse } from "@/lib/http-errors";
import { requireApiIdentity, requireMutationOrigin, unauthenticatedResponse } from "@/lib/request-auth";

const profiles = {
  codex: {
    name: "Codex",
    description: "Codex connector installed during guided onboarding",
    capabilities: ["repository.read", "code.review", "test.run", "artifact.create"],
    domains: ["software_delivery"],
  },
  hermes: {
    name: "Hermes",
    description: "Hermes coordinator connected during guided onboarding",
    capabilities: ["metrics.read", "logs.read", "health.verify", "report.create", "summary.create"],
    domains: ["systems_monitoring", "business_operations"],
  },
  claude_code: {
    name: "Claude Code",
    description: "Claude Code connector installed during guided onboarding",
    capabilities: ["repository.read", "code.review", "test.run", "artifact.create"],
    domains: ["software_delivery"],
  },
  generic_remote: {
    name: "Generic Remote Agent",
    description: "Protocol 1.0 remote agent connected during guided onboarding",
    capabilities: ["repository.read", "report.create", "summary.create"],
    domains: ["software_delivery", "business_operations"],
  },
} as const;

export async function POST(request: Request) {
  const originError = requireMutationOrigin(request);
  if (originError) return originError;
  const identity = await requireApiIdentity();
  if (!identity) return unauthenticatedResponse();
  try {
    const body = (await request.json()) as { agentType?: keyof typeof profiles };
    const profile = body.agentType ? profiles[body.agentType] : undefined;
    if (!profile) return NextResponse.json({ error: { message: "Choose a supported agent type." } }, { status: 400 });

    const publicUrl = (process.env.MISSION_CONTROL_PUBLIC_URL ?? new URL(request.url).origin).replace(/\/$/, "");
    const registration = await registerRemoteAgent({
      actor: identity,
      name: profile.name,
      description: profile.description,
      endpoint: `${publicUrl}/api/agent-protocol/v1/messages`,
      capabilities: [...profile.capabilities],
      supportedDomains: [...profile.domains],
      concurrencyLimit: 1,
    });
    const config = Buffer.from(
      JSON.stringify({
        missionControlUrl: publicUrl,
        workspaceId: identity.workspaceId,
        agentId: registration.agentId,
        credentialId: registration.credential.credentialId,
        secret: registration.credential.secret,
        agentType: body.agentType,
        agentName: profile.name,
        capabilities: profile.capabilities,
      }),
    ).toString("base64url");
    const command = `curl -fsSL ${publicUrl}/connect-agent.mjs | node -- --install '${config}'`;
    return NextResponse.json(
      {
        agentId: registration.agentId,
        agentName: profile.name,
        command,
        endpoint: `${publicUrl}/api/agent-protocol/v1/messages`,
        credentialId: registration.credential.credentialId,
        protocolVersion: registration.credential.protocolVersion,
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error, "onboarding_agent_connection_failed");
  }
}
