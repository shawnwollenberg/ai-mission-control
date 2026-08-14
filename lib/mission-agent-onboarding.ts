import { parseAgentProviderProfile, type AgentProviderProfile } from "@/domain/agent-provider";

export type OnboardingAgentType = "codex" | "hermes" | "claude_code" | "generic_remote";
export type OnboardingMode = "standard" | "consensus";
const onboardingAgentTypes = ["codex", "hermes", "claude_code", "generic_remote"] as const;
const onboardingModes = ["standard", "consensus"] as const;

const commonPlanningOperations = [
  "inspect_repository",
  "prepare_project_brain_context",
  "generate_structured_plan",
  "critique_plan",
  "revise_plan",
  "review_canonical_plan",
] as const;

function consensusProviderProfile(agentType: "codex" | "claude_code"): AgentProviderProfile {
  const provider = agentType;
  const models =
    provider === "codex"
      ? [
          {
            model_id: "gpt-5.6-sol",
            display_name: "GPT-5.6 Sol",
            provider,
            supported_roles: ["planner", "synthesizer"],
            supported_operations: commonPlanningOperations,
            structured_output: true,
            repository_read: true,
            repository_mutation: false,
            plan_mode: true,
            runtime_model_identity: "unverifiable",
          },
          {
            model_id: "gpt-5.6-luna",
            display_name: "GPT-5.6 Luna",
            provider,
            supported_roles: ["executor"],
            supported_operations: ["implement_change"],
            structured_output: true,
            repository_read: true,
            repository_mutation: true,
            plan_mode: false,
            runtime_model_identity: "unverifiable",
          },
        ]
      : [
          {
            model_id: "claude-fable-5",
            display_name: "Claude Fable 5",
            provider,
            supported_roles: ["planner", "synthesizer"],
            supported_operations: commonPlanningOperations,
            structured_output: true,
            repository_read: true,
            repository_mutation: false,
            plan_mode: true,
            runtime_model_identity: "unverifiable",
          },
        ];
  return parseAgentProviderProfile({
    provider,
    agent_version: "0.8.0",
    supported_mission_roles: provider === "codex" ? ["planner", "reviewer", "executor"] : ["planner", "reviewer"],
    supported_operations:
      provider === "codex" ? [...commonPlanningOperations, "implement_change"] : commonPlanningOperations,
    supported_models: models.map((model) => model.model_id),
    model_capabilities: models,
    capability_attestation_version: 1,
    capability_source: "operator_allowlist",
    structured_output: true,
    project_brain_context: true,
    repository_mutation: provider === "codex",
  });
}

const standardCapabilities = [
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
] as const;

export function onboardingProfile(mode: OnboardingMode, agentType: OnboardingAgentType) {
  if (!onboardingModes.includes(mode) || !onboardingAgentTypes.includes(agentType)) return undefined;
  if (mode === "consensus") {
    if (agentType !== "codex" && agentType !== "claude_code") return undefined;
    const providerProfile = consensusProviderProfile(agentType);
    return {
      name: agentType === "codex" ? "Governed Consensus – Codex" : "Governed Consensus – Claude Code",
      description: "Mission Agent 0.8 governed Consensus runtime connected through dedicated onboarding",
      capabilities:
        agentType === "codex"
          ? [...standardCapabilities, "repository.isolated_worktree_write", "git.commit_local"]
          : standardCapabilities.filter(
              (capability) => !["repository.write", "code.implement", "test.run", "git.commit"].includes(capability),
            ),
      domains: ["software_delivery"],
      providerProfile,
      missionAgentVersion: "0.8.0",
      missionAgentChecksum: "c366c95674fed2c8f63dd9f0182e54ee25d9a7d71764afe89b0facd734864494",
      artifactMetadataChecksum: "6455ae5f4fa0fa5c7dffd2e1069092d11b9834616fdd93ae6cdfdcc714c419a1",
      capabilityManifestChecksum: "aae4fe13b7cb613131accb870cbebb57cefbad4a955739fe85776a4488267394",
    } as const;
  }
  const standard = {
    codex: {
      name: "Codex",
      description: "Codex connector installed during guided onboarding",
      capabilities: [...standardCapabilities],
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
      capabilities: [...standardCapabilities],
      domains: ["software_delivery"],
    },
    generic_remote: {
      name: "Generic Remote Agent",
      description: "Protocol 1.0 remote agent connected during guided onboarding",
      capabilities: ["repository.read", "report.create", "summary.create"],
      domains: ["software_delivery", "business_operations"],
    },
  } as const;
  return {
    ...standard[agentType],
    providerProfile: undefined,
    missionAgentVersion: "0.7.2",
    missionAgentChecksum: "108e5587e8ffce0c37639e041cd2dcc2b51079f395beb04b26c1d4d9330bee09",
  } as const;
}

export function standardArtifactMetadata() {
  return JSON.stringify({
    artifactByteLength: 148063,
    canonicalizationVersion: "release-manifest-json-v3",
    manifestVersion: "3",
    publicKeyFingerprint: "ed25519-spki-sha256:7943a55a297cd50faf0a5841d06bcd0046d84dab73cc83543ba4021520706e8b",
    releaseAuthorityVersion: "v2",
    sha256: "108e5587e8ffce0c37639e041cd2dcc2b51079f395beb04b26c1d4d9330bee09",
    signingKeyId: "mission-agent-release-2026-01",
    sourceCommit: "31b45c98f2ffba613b56cd23819ba8b0c9c09a43",
    version: "0.7.2",
  });
}
