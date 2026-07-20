import { NextResponse } from "next/server";
import { registerRemoteAgent } from "@/application/remote-agent-registry";
import { getDatabasePool } from "@/lib/database";
import { recordOnboardingEvent } from "@/application/onboarding-events";
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

    const publicUrl = (
      process.env.MISSION_CONTROL_PUBLIC_URL ??
      process.env.PUBLIC_APP_URL ??
      new URL(request.url).origin
    ).replace(/\/$/, "");
    const workspaceName = (
      await getDatabasePool().query<{ name: string }>("SELECT name FROM workspaces WHERE id=$1", [identity.workspaceId])
    ).rows[0]?.name;
    const environmentName = workspaceName?.endsWith("'s Workspace")
      ? workspaceName.replace(/'s Workspace$/, "'s Computer")
      : "My Computer";
    const agentName = `${environmentName} – ${profile.name}`;
    const registration = await registerRemoteAgent({
      actor: identity,
      name: agentName,
      description: profile.description,
      endpoint: `${publicUrl}/api/agent-protocol/v1/messages`,
      capabilities: [...profile.capabilities],
      supportedDomains: [...profile.domains],
      concurrencyLimit: 1,
      deliveryMode: "pull",
      missionAgentAdapter:
        body.agentType === "claude_code"
          ? "claude-code"
          : body.agentType === "generic_remote"
            ? "generic"
            : body.agentType,
    });
    const config = Buffer.from(
      JSON.stringify({
        missionControlUrl: publicUrl,
        workspaceId: identity.workspaceId,
        agentId: registration.agentId,
        credentialId: registration.credential.credentialId,
        secret: registration.credential.secret,
        agentType: body.agentType,
        agentName,
        capabilities: profile.capabilities,
        workspaceName: workspaceName ?? "My Workspace",
      }),
    ).toString("base64url");
    const missionAgentVersion = "0.2.0";
    const missionAgentChecksum = "9c6ca19f4cdea7e94167becb3a820acba3ac0c925c5802d7ffe29e4150d6b48e";
    const command = `tmp_dir=$(mktemp -d) && tmp="$tmp_dir/mission-agent-${missionAgentVersion}.mjs" && curl -fsSL '${publicUrl}/mission-agent-${missionAgentVersion}.mjs' -o "$tmp" && printf '%s  %s\\n' '${missionAgentChecksum}' "$tmp" | shasum -a 256 -c - && node "$tmp" connect '${config}'`;
    await recordOnboardingEvent({
      workspaceId: identity.workspaceId,
      actorId: identity.userId,
      eventType: "onboarding.agent_selected",
      payload: { agentType: body.agentType, agentId: registration.agentId },
    });
    await recordOnboardingEvent({
      workspaceId: identity.workspaceId,
      actorId: identity.userId,
      eventType: "onboarding.connection_command_generated",
      payload: { agentId: registration.agentId, missionAgentVersion },
    });
    return NextResponse.json(
      {
        agentId: registration.agentId,
        agentName,
        command,
        endpoint: `${publicUrl}/api/agent-protocol/v1/messages`,
        credentialId: registration.credential.credentialId,
        protocolVersion: registration.credential.protocolVersion,
        missionAgentVersion,
        missionAgentChecksum,
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error, "onboarding_agent_connection_failed");
  }
}
