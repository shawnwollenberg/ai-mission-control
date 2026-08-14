import { NextResponse } from "next/server";
import { registerRemoteAgent } from "@/application/remote-agent-registry";
import { getDatabasePool } from "@/lib/database";
import { recordOnboardingEvent } from "@/application/onboarding-events";
import { apiErrorResponse } from "@/lib/http-errors";
import { requireApiIdentity, requireMutationOrigin, unauthenticatedResponse } from "@/lib/request-auth";
import { parseAgentProviderProfile } from "@/domain/agent-provider";
import {
  onboardingProfile,
  standardArtifactMetadata,
  type OnboardingAgentType,
  type OnboardingMode,
} from "@/lib/mission-agent-onboarding";

export async function POST(request: Request) {
  const originError = requireMutationOrigin(request);
  if (originError) return originError;
  const identity = await requireApiIdentity();
  if (!identity) return unauthenticatedResponse();
  try {
    const body = (await request.json()) as { agentType?: OnboardingAgentType; mode?: OnboardingMode };
    const mode = body.mode ?? "standard";
    const profile = body.agentType ? onboardingProfile(mode, body.agentType) : undefined;
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
      providerProfile: profile.providerProfile ? parseAgentProviderProfile(profile.providerProfile) : undefined,
    });
    const config = Buffer.from(
      JSON.stringify({
        missionControlUrl: publicUrl,
        workspaceId: identity.workspaceId,
        agentId: registration.agentId,
        credentialId: registration.credential.credentialId,
        secret: registration.credential.secret,
        agentType: body.agentType,
        onboardingMode: mode,
        agentName,
        capabilities: profile.capabilities,
        providerProfile: profile.providerProfile ? parseAgentProviderProfile(profile.providerProfile) : undefined,
        workspaceName: workspaceName ?? "My Workspace",
      }),
    ).toString("base64url");
    const missionAgentVersion = profile.missionAgentVersion;
    const missionAgentChecksum = profile.missionAgentChecksum;
    const command =
      mode === "consensus"
        ? `tmp_dir=$(mktemp -d) && tmp="$tmp_dir/mission-agent-${missionAgentVersion}.mjs" && metadata="$tmp.artifact.json" && capabilities="$tmp.capabilities.json" && agent_home="$HOME/.mission-agent-consensus-${body.agentType}" && agent_bin="$HOME/.local/mission-agent-consensus-${body.agentType}" && curl -fsSL '${publicUrl}/mission-agent-${missionAgentVersion}.mjs' -o "$tmp" && curl -fsSL '${publicUrl}/mission-agent-${missionAgentVersion}.mjs.artifact.json' -o "$metadata" && curl -fsSL '${publicUrl}/mission-agent-${missionAgentVersion}.mjs.capabilities.json' -o "$capabilities" && printf '%s  %s\\n' '${missionAgentChecksum}' "$tmp" '${profile.artifactMetadataChecksum}' "$metadata" '${profile.capabilityManifestChecksum}' "$capabilities" | shasum -a 256 -c - && mkdir -p "$agent_home" "$agent_bin" && chmod 700 "$agent_home" "$agent_bin" && MISSION_AGENT_HOME="$agent_home" MISSION_AGENT_BIN_DIR="$agent_bin" node "$(realpath "$tmp")" connect '${config}' --no-start && (nohup env MISSION_AGENT_HOME="$agent_home" node "$agent_home/mission-agent-${missionAgentVersion}.mjs" run </dev/null >>"$agent_home/mission-agent.log" 2>>"$agent_home/mission-agent-error.log" &)`
        : `tmp_dir=$(mktemp -d) && tmp="$tmp_dir/mission-agent-${missionAgentVersion}.mjs" && metadata="$tmp.artifact.json" && curl -fsSL '${publicUrl}/mission-agent-${missionAgentVersion}.mjs' -o "$tmp" && printf '%s  %s\\n' '${missionAgentChecksum}' "$tmp" | shasum -a 256 -c - && printf '%s\\n' '${standardArtifactMetadata()}' > "$metadata" && chmod 600 "$metadata" && node "$tmp" connect '${config}'`;
    await recordOnboardingEvent({
      workspaceId: identity.workspaceId,
      actorId: identity.userId,
      eventType: "onboarding.agent_selected",
      payload: { agentType: body.agentType, onboardingMode: mode, agentId: registration.agentId },
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
        onboardingMode: mode,
        missionAgentVersion,
        missionAgentChecksum,
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error, "onboarding_agent_connection_failed");
  }
}
