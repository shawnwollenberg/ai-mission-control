import { evaluateAgentEligibility } from "../application/agent-eligibility";
import type { AgentOperation, ModelCapabilityRole } from "../domain/agent-provider";

export type AcceptanceEligibilityRole = {
  role: "planner_a" | "planner_b" | "synthesizer" | "executor";
  agentId: string;
  provider: "codex" | "claude_code";
  model: string;
  missionRole: "planner" | "executor";
  modelRole: ModelCapabilityRole;
  operations: AgentOperation[];
  requiredCapabilities: string[];
  repositoryPermission: "read" | "isolated_worktree_write";
  requireProjectBrainContext?: boolean;
  requireRepositoryMutation?: boolean;
};

export type AcceptanceEligibilityObservation = {
  role: AcceptanceEligibilityRole["role"];
  agentId: string;
  provider: string;
  model: string;
  capabilityAttestationId: string;
  capabilityAttestationHash: string;
  runtimeProfileId: string;
  runtimeBindingHash: string;
};

export async function establishFreshEligibility<T>(input: {
  workspaceId: string;
  repositoryId: string;
  requiredRoles: AcceptanceEligibilityRole[];
  heartbeat: (agentId: string) => Promise<void>;
  action: (observations: AcceptanceEligibilityObservation[]) => Promise<T>;
  evaluate?: typeof evaluateAgentEligibility;
}): Promise<T> {
  if (!input.requiredRoles.length) throw new TypeError("At least one governed role is required");
  const uniqueAgents = Array.from(new Set(input.requiredRoles.map((binding) => binding.agentId)));
  let observations: AcceptanceEligibilityObservation[] = [];
  const evaluate = input.evaluate ?? evaluateAgentEligibility;
  for (let readinessAttempt = 1; readinessAttempt <= 2; readinessAttempt += 1) {
    for (const agentId of uniqueAgents) await input.heartbeat(agentId);
    observations = [];
    for (const binding of input.requiredRoles) {
      const eligibility = await evaluate({
        workspaceId: input.workspaceId,
        agentId: binding.agentId,
        domain: "software_delivery",
        requiredCapabilities: binding.requiredCapabilities,
        requiredResources: [
          {
            resourceType: "repository",
            resourceId: input.repositoryId,
            permission: binding.repositoryPermission,
          },
        ],
        protocolVersion: "1.0",
        requiredMissionRole: binding.missionRole,
        requiredOperations: binding.operations,
        requiredModel: binding.model,
        requiredModelRole: binding.modelRole,
        requireStructuredOutput: true,
        requireProjectBrainContext: binding.requireProjectBrainContext,
        requireRepositoryMutation: binding.requireRepositoryMutation,
        requireVerifiedMissionAgentArtifact: true,
      });
      if (
        !eligibility.eligible ||
        eligibility.providerId !== binding.provider ||
        !eligibility.capabilityAttestationId ||
        !eligibility.capabilityAttestationHash ||
        !eligibility.providerRuntimeProfile
      ) {
        observations = [];
        break;
      }
      observations.push({
        role: binding.role,
        agentId: binding.agentId,
        provider: eligibility.providerId,
        model: binding.model,
        capabilityAttestationId: eligibility.capabilityAttestationId,
        capabilityAttestationHash: eligibility.capabilityAttestationHash,
        runtimeProfileId: eligibility.providerRuntimeProfile.profileId,
        runtimeBindingHash: eligibility.providerRuntimeProfile.runtimeBindingHash,
      });
    }
    if (observations.length === input.requiredRoles.length) break;
    if (readinessAttempt === 2)
      throw new Error("Acceptance eligibility barrier could not establish every declared governed role");
  }
  // No action retry is permitted: once the callback begins, the governed command
  // owns admission and any possible side effects.
  return input.action(observations);
}
