import {
  capabilityValues,
  validateMission,
  validateRoutingSignal,
  type ArchitectDecision,
  type CtoDecision,
  type CtoRequest,
  type EngineerReport,
  type Mission,
  type OwnerReconciliation,
  type RoutingSignal,
} from "../routing/contracts";

export type EnvelopeKind =
  "mission" | "engineer-report" | "architect-decision" | "cto-request" | "cto-decision" | "owner-reconciliation";

const schemas: Record<EnvelopeKind, string> = {
  mission: "mc.mission/v1",
  "engineer-report": "mc.engineer-report/v1",
  "architect-decision": "mc.architect-decision/v1",
  "cto-request": "mc.cto-request/v1",
  "cto-decision": "mc.cto-decision/v1",
  "owner-reconciliation": "mc.owner-reconciliation/v1",
};

const kinds = Object.keys(schemas) as EnvelopeKind[];

function marker(kind: EnvelopeKind, edge: "start" | "end") {
  return `<!-- mission-control:${kind}:${edge} -->`;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: string[], name: string) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    throw new Error(`${name} contains missing or unknown fields`);
}

function text(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be non-empty text`);
}

function stringArray(value: unknown, name: string) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    throw new Error(`${name} must be a string array`);
}

function validateEvidence(value: unknown) {
  if (!Array.isArray(value)) throw new Error("Evidence must be an array");
  for (const entry of value) {
    const item = record(entry, "Evidence entry");
    const allowed = ["kind", "ref", "result", "revision"];
    if (Object.keys(item).some((key) => !allowed.includes(key))) throw new Error("Evidence contains unknown fields");
    text(item.kind, "Evidence kind");
    if (item.ref !== undefined) text(item.ref, "Evidence ref");
    if (item.result !== undefined) text(item.result, "Evidence result");
    if (item.revision !== undefined && (!Number.isSafeInteger(item.revision) || Number(item.revision) < 1))
      throw new Error("Evidence revision must be positive");
  }
}

function parseJson(raw: string) {
  const trimmed = raw
    .trim()
    .replace(/^```json\s*/, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error("Machine envelope contains malformed JSON");
  }
}

function validateMissionEnvelope(value: unknown): Mission {
  const item = record(value, "Mission");
  exact(
    item,
    ["schema", "missionId", "revision", "objective", "acceptanceCriteria", "constraints", "state", "currentActor"],
    "Mission",
  );
  stringArray(item.acceptanceCriteria, "Mission acceptanceCriteria");
  stringArray(item.constraints, "Mission constraints");
  const actorsByState = {
    NEW: "ARCHITECT",
    ARCHITECT_PLANNING: "ARCHITECT",
    ENGINEER_WORKING: "ENGINEER",
    ARCHITECT_REVIEW: "ARCHITECT",
    CTO_DECISION: "CTO",
    BLOCKED_EXTERNAL: "EXTERNAL",
    COMPLETE: "NONE",
  };
  if (typeof item.state !== "string" || !(item.state in actorsByState)) throw new Error("Mission state is unsupported");
  if (item.currentActor !== actorsByState[item.state as keyof typeof actorsByState])
    throw new Error("Mission currentActor does not match state");
  return validateMission(item as Mission);
}

function validateSignalEnvelope(value: unknown): RoutingSignal {
  const item = record(value, "Signal");
  if (typeof item.schema !== "string" || !Object.values(schemas).includes(item.schema))
    throw new Error("Unknown machine envelope schema");
  if (item.schema === "mc.engineer-report/v1") {
    exact(
      item,
      [
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
      "Engineer Report",
    );
    validateEvidence(item.evidence);
    stringArray(item.risks, "Engineer Report risks");
    stringArray(item.blockedOn, "Engineer Report blockedOn");
    if (!["COMPLETED", "PARTIAL", "BLOCKED", "FAILED"].includes(String(item.outcome)))
      throw new Error("Engineer Report outcome is unsupported");
    if (
      !Array.isArray(item.capabilitiesRequested) ||
      item.capabilitiesRequested.some((entry) => !capabilityValues.includes(entry))
    )
      throw new Error("Engineer Report contains an unsupported capability");
  } else if (item.schema === "mc.architect-decision/v1") {
    exact(item, ["schema", "missionId", "revision", "decision", "rationale", "nextMission"], "Architect Decision");
    if (item.nextMission !== null) {
      const next = record(item.nextMission, "Architect nextMission");
      exact(next, ["objective", "acceptanceCriteria", "constraints"], "Architect nextMission");
      text(next.objective, "Architect nextMission objective");
      stringArray(next.acceptanceCriteria, "Architect nextMission acceptanceCriteria");
      stringArray(next.constraints, "Architect nextMission constraints");
    }
    if (!["APPROVE", "REMEDIATE", "CTO_REQUIRED", "BLOCKED_EXTERNAL"].includes(String(item.decision)))
      throw new Error("Architect Decision is unsupported");
  } else if (item.schema === "mc.cto-request/v1") {
    exact(
      item,
      [
        "schema",
        "missionId",
        "revision",
        "capability",
        "action",
        "financialEffect",
        "externalEffect",
        "reversible",
        "architectRecommendation",
        "evidence",
        "status",
      ],
      "CTO Request",
    );
    if (!(capabilityValues as readonly unknown[]).includes(item.capability))
      throw new Error("CTO Request contains an unsupported capability");
    for (const [name, value] of [
      ["action", item.action],
      ["financialEffect", item.financialEffect],
      ["externalEffect", item.externalEffect],
    ] as const)
      text(value, `CTO Request ${name}`);
    if (typeof item.reversible !== "boolean") throw new Error("CTO Request reversible must be boolean");
    if (!["APPROVE", "REJECT"].includes(String(item.architectRecommendation)))
      throw new Error("CTO Request recommendation is unsupported");
    if (item.status !== "PENDING") throw new Error("CTO Request status must be PENDING");
    validateEvidence(item.evidence);
  } else if (item.schema === "mc.cto-decision/v1") {
    exact(
      item,
      [
        "schema",
        "missionId",
        "revision",
        "requestRevision",
        "decision",
        ...(item.comment === undefined ? [] : ["comment"]),
      ],
      "CTO Decision",
    );
    if (!Number.isSafeInteger(item.requestRevision) || Number(item.requestRevision) < 1)
      throw new Error("CTO Decision requestRevision must be positive");
    if (!["APPROVED", "REJECTED", "DISCUSS"].includes(String(item.decision)))
      throw new Error("CTO Decision is unsupported");
    if (item.comment !== undefined && typeof item.comment !== "string")
      throw new Error("CTO Decision comment must be text");
  } else {
    exact(item, ["schema", "missionId", "revision", "blockedRevision", "reason", "evidence"], "Owner Reconciliation");
    if (!Number.isSafeInteger(item.blockedRevision) || Number(item.blockedRevision) < 1)
      throw new Error("Owner Reconciliation blockedRevision must be positive");
    text(item.reason, "Owner Reconciliation reason");
    validateEvidence(item.evidence);
    if (!Array.isArray(item.evidence) || item.evidence.length < 1)
      throw new Error("Owner Reconciliation requires evidence");
  }
  return validateRoutingSignal(item as RoutingSignal);
}

export function renderEnvelope(kind: EnvelopeKind, value: Mission | RoutingSignal) {
  if (value.schema !== schemas[kind]) throw new Error(`Envelope kind ${kind} does not match ${value.schema}`);
  return `${marker(kind, "start")}\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n${marker(kind, "end")}`;
}

export function renderMissionBody(mission: Mission) {
  validateMissionEnvelope(mission);
  return [
    "## Objective",
    "",
    mission.objective,
    "",
    "## Acceptance criteria",
    "",
    ...mission.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "",
    "## Constraints",
    "",
    ...mission.constraints.map((constraint) => `- ${constraint}`),
    "",
    renderEnvelope("mission", mission),
  ].join("\n");
}

export function replaceMissionEnvelope(body: string, mission: Mission) {
  const start = marker("mission", "start");
  const end = marker("mission", "end");
  const startIndex = body.indexOf(start);
  const endIndex = body.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0 || body.indexOf(start, startIndex + start.length) >= 0)
    throw new Error("Issue body must contain exactly one Mission envelope");
  return `${body.slice(0, startIndex)}${renderEnvelope("mission", mission)}${body.slice(endIndex + end.length)}`;
}

export function parseMissionBody(body: string) {
  const parsed = extract(body, "mission");
  if (!parsed) throw new Error("Issue body is missing the Mission envelope");
  return validateMissionEnvelope(parsed);
}

export function parseMachineComment(body: string): RoutingSignal | undefined {
  const present = kinds.filter((kind) => body.includes(marker(kind, "start")) || body.includes(marker(kind, "end")));
  if (!present.length) {
    if (body.includes("<!-- mission-control:")) throw new Error("Unknown Mission Control marker");
    return undefined;
  }
  if (present.length !== 1 || present[0] === "mission")
    throw new Error("Comment must contain exactly one signal envelope");
  const parsed = extract(body, present[0]);
  if (!parsed) throw new Error("Comment contains an incomplete machine envelope");
  const signal = validateSignalEnvelope(parsed);
  if (signal.schema !== schemas[present[0]]) throw new Error("Comment marker and schema do not match");
  return signal;
}

function extract(body: string, kind: EnvelopeKind): unknown | undefined {
  const start = marker(kind, "start");
  const end = marker(kind, "end");
  const startIndex = body.indexOf(start);
  const endIndex = body.indexOf(end, startIndex + start.length);
  if (startIndex < 0 && endIndex < 0) return undefined;
  if (
    startIndex < 0 ||
    endIndex < 0 ||
    body.indexOf(start, startIndex + start.length) >= 0 ||
    body.indexOf(end, endIndex + end.length) >= 0
  )
    throw new Error(`Body must contain exactly one bounded ${kind} envelope`);
  return parseJson(body.slice(startIndex + start.length, endIndex));
}

export function envelopeKind(signal: RoutingSignal): Exclude<EnvelopeKind, "mission"> {
  const found = kinds.find((kind) => schemas[kind] === signal.schema);
  if (!found || found === "mission") throw new Error("Unsupported signal schema");
  return found;
}

export type { ArchitectDecision, CtoDecision, CtoRequest, EngineerReport, OwnerReconciliation };
