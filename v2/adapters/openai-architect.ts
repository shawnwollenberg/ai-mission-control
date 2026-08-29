import OpenAI from "openai";
import type { EngineerReport, Mission, ProjectConstitution, RoutingSignal } from "../routing/contracts";
import { architectDecisionSchema, parseArchitectDecision } from "./schemas";

export const ARCHITECT_INSTRUCTIONS_VERSION = "mc.architect-instructions/1";
type ResponsesClient = {
  responses: { create(input: Record<string, unknown>): Promise<{ id: string; output_text: string }> };
};

export class OpenAIResponsesArchitectAdapter {
  constructor(
    private readonly client?: ResponsesClient,
    private readonly model = "gpt-5.4",
  ) {}
  async review(input: {
    mission: Mission;
    constitution: ProjectConstitution;
    engineerReport?: EngineerReport;
    priorSignal?: RoutingSignal;
    previousResponseId?: string;
  }) {
    const revision = input.mission.revision + 1;
    const client = this.client ?? new OpenAI();
    const response = await client.responses.create({
      model: this.model,
      instructions: [
        `${ARCHITECT_INSTRUCTIONS_VERSION}. You are the read-only technical Architect. Produce decisions; Mission Control routes them.`,
        "You have no mutation tools. Escalate only capabilities owned by the CTO. Never imply general or future approval.",
      ].join(" "),
      input: JSON.stringify({
        mission: input.mission,
        engineerReport: input.engineerReport,
        routedSignal: input.priorSignal,
        authority: input.constitution.authority,
        requiredMissionId: input.mission.missionId,
        requiredRevision: revision,
      }),
      ...(input.previousResponseId ? { previous_response_id: input.previousResponseId } : {}),
      text: {
        format: { type: "json_schema", name: "architect_decision", strict: true, schema: architectDecisionSchema },
      },
      tools: [],
      store: true,
    });
    if (!response.output_text) throw new Error("Architect response did not contain structured output");
    const decision = parseArchitectDecision(JSON.parse(response.output_text), input.mission.missionId, revision);
    return { decision, responseId: response.id };
  }
}
