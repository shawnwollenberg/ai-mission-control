import {
  capabilityValues,
  validateRoutingSignal,
  type ArchitectDecision,
  type EngineerReport,
} from "../routing/contracts";

const evidence = {
  type: "array",
  items: {
    type: "object",
    properties: { kind: { type: "string" }, ref: { type: "string" }, result: { type: "string" } },
    required: ["kind", "ref", "result"],
    additionalProperties: false,
  },
};

export const engineerReportSchema = {
  type: "object",
  properties: {
    schema: { type: "string", const: "mc.engineer-report/v1" },
    missionId: { type: "string" },
    revision: { type: "integer", minimum: 2 },
    outcome: { type: "string", enum: ["COMPLETED", "PARTIAL", "BLOCKED", "FAILED"] },
    summary: { type: "string" },
    evidence,
    risks: { type: "array", items: { type: "string" } },
    blockedOn: { type: "array", items: { type: "string" } },
    capabilitiesRequested: { type: "array", items: { type: "string", enum: capabilityValues } },
  },
  required: [
    "schema",
    "missionId",
    "revision",
    "outcome",
    "summary",
    "evidence",
    "risks",
    "blockedOn",
    "capabilitiesRequested",
  ],
  additionalProperties: false,
} as const;

export const architectDecisionSchema = {
  type: "object",
  properties: {
    schema: { type: "string", const: "mc.architect-decision/v1" },
    missionId: { type: "string" },
    revision: { type: "integer", minimum: 2 },
    decision: { type: "string", enum: ["APPROVE", "REMEDIATE", "CTO_REQUIRED", "BLOCKED_EXTERNAL"] },
    rationale: { type: "string" },
    nextMission: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          properties: {
            objective: { type: "string" },
            acceptanceCriteria: { type: "array", items: { type: "string" } },
            constraints: { type: "array", items: { type: "string" } },
          },
          required: ["objective", "acceptanceCriteria", "constraints"],
          additionalProperties: false,
        },
      ],
    },
  },
  required: ["schema", "missionId", "revision", "decision", "rationale", "nextMission"],
  additionalProperties: false,
} as const;

export function parseEngineerReport(text: string, missionId: string, revision: number): EngineerReport {
  const report = validateRoutingSignal(JSON.parse(text) as EngineerReport) as EngineerReport;
  if (report.schema !== "mc.engineer-report/v1" || report.missionId !== missionId || report.revision !== revision)
    throw new Error("Engineer report is not bound to the dispatched mission revision");
  return report;
}

export function parseArchitectDecision(value: unknown, missionId: string, revision: number): ArchitectDecision {
  const decision = validateRoutingSignal(value as ArchitectDecision) as ArchitectDecision;
  if (
    decision.schema !== "mc.architect-decision/v1" ||
    decision.missionId !== missionId ||
    decision.revision !== revision
  )
    throw new Error("Architect decision is not bound to the reviewed mission revision");
  if (decision.decision === "REMEDIATE" ? !decision.nextMission : decision.nextMission !== null)
    throw new Error("Architect nextMission does not match the decision");
  return decision;
}
