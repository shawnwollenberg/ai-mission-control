import type {
  ArchitectDecision,
  EngineerReport,
  Mission,
  ProjectConstitution,
  RoutingSignal,
} from "../routing/contracts";

export type WorkspaceAgentArchitectDispatch = {
  mission: Mission;
  constitution: ProjectConstitution;
  engineerReport?: EngineerReport;
  priorSignal?: RoutingSignal;
  conversationKey: string;
  idempotencyKey: string;
};

/**
 * Future ChatGPT-native Architect boundary. A concrete adapter must trigger a
 * published Workspace Agent and receive its decision through a separately
 * authenticated, narrow Mission Control callback because trigger responses do
 * not currently expose the Agent's final output.
 */
export interface WorkspaceAgentArchitectAdapter {
  trigger(input: WorkspaceAgentArchitectDispatch): Promise<{
    conversationUrl: string;
    runId?: string;
  }>;
  acceptDecision(input: { decision: ArchitectDecision; conversationKey: string; runId?: string }): Promise<void>;
}
