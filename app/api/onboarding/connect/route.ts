import { NextResponse } from "next/server";
import { registerRemoteAgent } from "@/application/remote-agent-registry";
import { getDatabasePool } from "@/lib/database";
import { recordOnboardingEvent } from "@/application/onboarding-events";
import { apiErrorResponse } from "@/lib/http-errors";
import { requireApiIdentity, requireMutationOrigin, unauthenticatedResponse } from "@/lib/request-auth";
import { parseAgentProviderProfile } from "@/domain/agent-provider";

const profiles = {
  codex: {
    name: "Codex",
    description: "Codex connector installed during guided onboarding",
    capabilities: [
      "repository.read",
      "repository.write",
      "code.implement",
      "code.review",
      "test.run",
      "git.commit",
      "artifact.create",
      "plan.generate",
      "plan.critique",
      "plan.revise",
      "plan.review",
      "project_brain.context",
    ],
    domains: ["software_delivery"],
    providerProfile: undefined,
  },
  hermes: {
    name: "Hermes",
    description: "Hermes coordinator connected during guided onboarding",
    capabilities: ["metrics.read", "logs.read", "health.verify", "report.create", "summary.create"],
    domains: ["systems_monitoring", "business_operations"],
    providerProfile: undefined,
  },
  claude_code: {
    name: "Claude Code",
    description: "Claude Code connector installed during guided onboarding",
    capabilities: [
      "repository.read",
      "repository.write",
      "code.implement",
      "code.review",
      "test.run",
      "git.commit",
      "artifact.create",
      "plan.generate",
      "plan.critique",
      "plan.revise",
      "plan.review",
      "project_brain.context",
    ],
    domains: ["software_delivery"],
    providerProfile: undefined,
  },
  generic_remote: {
    name: "Generic Remote Agent",
    description: "Protocol 1.0 remote agent connected during guided onboarding",
    capabilities: ["repository.read", "report.create", "summary.create"],
    domains: ["software_delivery", "business_operations"],
    providerProfile: undefined,
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
        agentName,
        capabilities: profile.capabilities,
        providerProfile: profile.providerProfile ? parseAgentProviderProfile(profile.providerProfile) : undefined,
        workspaceName: workspaceName ?? "My Workspace",
      }),
    ).toString("base64url");
    const missionAgentVersion = "0.7.2";
    const missionAgentChecksum = "108e5587e8ffce0c37639e041cd2dcc2b51079f395beb04b26c1d4d9330bee09";
    const artifactMetadata = JSON.stringify({
      artifactByteLength: 148063,
      canonicalizationVersion: "release-manifest-json-v3",
      manifestVersion: "3",
      publicKeyFingerprint: "ed25519-spki-sha256:7943a55a297cd50faf0a5841d06bcd0046d84dab73cc83543ba4021520706e8b",
      releaseAuthorityVersion: "v2",
      sha256: missionAgentChecksum,
      signingKeyId: "mission-agent-release-2026-01",
      sourceCommit: "31b45c98f2ffba613b56cd23819ba8b0c9c09a43",
      version: missionAgentVersion,
    });
    const command = `tmp_dir=$(mktemp -d) && tmp="$tmp_dir/mission-agent-${missionAgentVersion}.mjs" && metadata="$tmp.artifact.json" && curl -fsSL '${publicUrl}/mission-agent-${missionAgentVersion}.mjs' -o "$tmp" && printf '%s  %s\\n' '${missionAgentChecksum}' "$tmp" | shasum -a 256 -c - && printf '%s\\n' '${artifactMetadata}' > "$metadata" && chmod 600 "$metadata" && node "$tmp" connect '${config}'`;
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
