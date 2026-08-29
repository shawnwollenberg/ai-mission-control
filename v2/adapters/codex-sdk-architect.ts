import type { Thread, ThreadOptions } from "@openai/codex-sdk";
import type { EngineerReport, Mission, ProjectConstitution, RoutingSignal } from "../routing/contracts";
import { architectDecisionSchema, parseArchitectDecision } from "./schemas";

export const CODEX_ARCHITECT_INSTRUCTIONS_VERSION = "mc.codex-architect-instructions/1";

type CodexClient = {
  startThread(options?: ThreadOptions): Thread;
  resumeThread(id: string, options?: ThreadOptions): Thread;
};

export class CodexSdkArchitectAdapter {
  constructor(
    private readonly client?: CodexClient,
    private readonly model?: string,
  ) {}

  async review(input: {
    mission: Mission;
    constitution: ProjectConstitution;
    engineerReport?: EngineerReport;
    priorSignal?: RoutingSignal;
    architectThreadId?: string;
    localCheckout: string;
  }) {
    const options: ThreadOptions = {
      workingDirectory: input.localCheckout,
      model: this.model,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      modelReasoningEffort: "medium",
    };
    const client = this.client ?? new (await import("@openai/codex-sdk")).Codex();
    const thread = input.architectThreadId
      ? client.resumeThread(input.architectThreadId, options)
      : client.startThread(options);
    const revision = input.mission.revision + 1;
    const packet = [
      `${CODEX_ARCHITECT_INSTRUCTIONS_VERSION}. You are the read-only technical Architect adapter for Mission Control.`,
      "Make the technical decision only. Mission Control owns routing and all side effects.",
      "Do not modify files, execute external actions, deploy, sign, move money, change credentials, or grant authority.",
      "Treat an explicit staged acceptance sequence in the Mission as binding; do not skip a required remediation round or escalation boundary.",
      "Use REMEDIATE when acceptance evidence is incomplete and provide one bounded nextMission.",
      "When returning nextMission, preserve every still-pending staged acceptance requirement and authority constraint.",
      "Use CTO_REQUIRED only when the latest Engineer Report requests an exact capability assigned to ctoRequired; otherwise fail closed with REMEDIATE or BLOCKED_EXTERNAL.",
      "Use APPROVE only when all current mission acceptance criteria have evidence and no CTO-owned action remains pending.",
      `Mission: ${JSON.stringify(input.mission)}`,
      `Project constitution and authority: ${JSON.stringify(input.constitution)}`,
      `Latest Engineer Report: ${JSON.stringify(input.engineerReport ?? null)}`,
      `Latest routed signal: ${JSON.stringify(input.priorSignal ?? null)}`,
      `Return only mc.architect-decision/v1 for mission ${input.mission.missionId} at revision ${revision}.`,
    ].join("\n\n");
    const turn = await thread.run(packet, { outputSchema: architectDecisionSchema });
    const decision = parseArchitectDecision(JSON.parse(turn.finalResponse), input.mission.missionId, revision);
    if (!thread.id) throw new Error("Codex SDK did not return an Architect thread id");
    return { decision, architectThreadId: thread.id, usage: turn.usage };
  }
}
