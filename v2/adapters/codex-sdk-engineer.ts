import type { Thread, ThreadOptions } from "@openai/codex-sdk";
import type { Mission, ProjectConstitution, RoutingSignal } from "../routing/contracts";
import { engineerReportSchema, parseEngineerReport } from "./schemas";

type CodexClient = {
  startThread(options?: ThreadOptions): Thread;
  resumeThread(id: string, options?: ThreadOptions): Thread;
};

export class CodexSdkEngineerAdapter {
  constructor(
    private readonly client?: CodexClient,
    private readonly model?: string,
  ) {}

  async run(input: {
    mission: Mission;
    constitution: ProjectConstitution;
    localCheckout: string;
    priorSignal?: RoutingSignal;
    threadId?: string;
  }) {
    const options: ThreadOptions = {
      workingDirectory: input.localCheckout,
      model: this.model,
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      modelReasoningEffort: "medium",
    };
    const client = this.client ?? new (await import("@openai/codex-sdk")).Codex();
    const thread = input.threadId ? client.resumeThread(input.threadId, options) : client.startThread(options);
    const revision = input.mission.revision + 1;
    const allowed = input.constitution.authority.engineer;
    const packet = [
      "You are the Senior Engineer adapter for Mission Control. Work only inside the configured repository.",
      "Never deploy, move money, sign messages, expand credentials, accept legal terms, or claim CTO authority.",
      `Mission: ${JSON.stringify(input.mission)}`,
      `Granted Engineer capabilities: ${JSON.stringify(allowed)}`,
      `CTO-only capabilities may be listed in capabilitiesRequested for escalation but MUST NOT be exercised: ${JSON.stringify(input.constitution.authority.ctoRequired)}`,
      `Constraints: ${JSON.stringify(input.mission.constraints)}`,
      input.priorSignal
        ? `New routed signal: ${JSON.stringify(input.priorSignal)}`
        : "This is the first Engineer turn.",
      `Return only mc.engineer-report/v1 for mission ${input.mission.missionId} at revision ${revision}.`,
    ].join("\n\n");
    const turn = await thread.run(packet, { outputSchema: engineerReportSchema });
    const report = parseEngineerReport(turn.finalResponse, input.mission.missionId, revision);
    for (const capability of report.capabilitiesRequested)
      if (!allowed.includes(capability) && !input.constitution.authority.ctoRequired.includes(capability))
        throw new Error(`Engineer requested capability with no configured authority owner: ${capability}`);
    if (!thread.id) throw new Error("Codex SDK did not return a thread id");
    return { report, threadId: thread.id, usage: turn.usage };
  }
}
