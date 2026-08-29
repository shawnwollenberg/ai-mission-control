export const capabilityValues = [
  "CODE_WRITE",
  "TEST_EXECUTE",
  "REPO_COMMIT",
  "REPO_PUSH",
  "READ_EXTERNAL",
  "REVERSIBLE_DEV_OPERATION",
  "ROUTINE_DEBUGGING",
  "MISSION_CREATE",
  "MISSION_APPROVE",
  "MISSION_REMEDIATE",
  "ARCHITECTURE_DECISION",
  "NON_ECONOMIC_EXTERNAL_TEST",
  "TECHNICAL_RISK_DECISION",
  "MOVE_MONEY",
  "SIGN_WALLET_MESSAGE",
  "EXPAND_CREDENTIAL_AUTHORITY",
  "ACCEPT_LEGAL_TERMS",
  "MATERIAL_COST",
  "DESTRUCTIVE_PRODUCTION_ACTION",
  "IRREVERSIBLE_EXTERNAL_ACTION",
  "MAJOR_PRODUCT_SCOPE_CHANGE",
] as const;

export type Capability = (typeof capabilityValues)[number];
export type MissionState =
  | "NEW"
  | "ARCHITECT_PLANNING"
  | "ENGINEER_WORKING"
  | "ARCHITECT_REVIEW"
  | "CTO_DECISION"
  | "BLOCKED_EXTERNAL"
  | "COMPLETE";

export type ProjectConstitution = {
  schema: "mc.project-constitution/v1";
  projectId: string;
  repository: string;
  defaultBranch: string;
  architect: { adapter: string; channel: "CHATGPT" };
  engineer: { adapter: string };
  authority: {
    engineer: Capability[];
    architect: Capability[];
    ctoRequired: Capability[];
  };
};

export type Mission = {
  schema: "mc.mission/v1";
  missionId: string;
  revision: number;
  objective: string;
  acceptanceCriteria: string[];
  constraints: string[];
  state: MissionState;
  currentActor: "ARCHITECT" | "ENGINEER" | "CTO" | "EXTERNAL" | "NONE";
};

export type EngineerReport = {
  schema: "mc.engineer-report/v1";
  missionId: string;
  revision: number;
  outcome: "COMPLETED" | "PARTIAL" | "BLOCKED" | "FAILED";
  summary: string;
  evidence: Array<{ kind: string; ref: string; result?: string }>;
  risks: string[];
  blockedOn: string[];
  capabilitiesRequested: Capability[];
};

export type ArchitectDecision = {
  schema: "mc.architect-decision/v1";
  missionId: string;
  revision: number;
  decision: "APPROVE" | "REMEDIATE" | "CTO_REQUIRED" | "BLOCKED_EXTERNAL";
  rationale: string;
  nextMission: Pick<Mission, "objective" | "acceptanceCriteria" | "constraints"> | null;
  ctoRequest: CtoRequest | null;
};

export type CtoRequest = {
  schema: "mc.cto-request/v1";
  missionId: string;
  revision: number;
  capability: Capability;
  action: string;
  financialEffect: string;
  externalEffect: string;
  reversible: boolean;
  architectRecommendation: "APPROVE" | "REJECT";
  evidence: Array<{ kind: string; revision?: number; ref?: string }>;
  status: "PENDING";
};

export type CtoDecision = {
  schema: "mc.cto-decision/v1";
  missionId: string;
  revision: number;
  requestRevision: number;
  decision: "APPROVED" | "REJECTED" | "DISCUSS";
  comment?: string;
};

export type RoutingSignal = EngineerReport | ArchitectDecision | CtoDecision;

export type ArchitectDispatch = {
  actor: "ARCHITECT";
  channel: "CHATGPT";
  adapter: string;
  reason: "ENGINEER_REPORT_READY" | "CTO_REJECTED" | "CTO_DISCUSS";
  idempotencyKey: string;
};

export type EngineerDispatch = {
  actor: "ENGINEER";
  adapter: string;
  reason: "REMEDIATION" | "CTO_APPROVED";
  idempotencyKey: string;
};

export interface ArchitectAdapter {
  dispatch(mission: Mission, signal: RoutingSignal, request: ArchitectDispatch): Promise<void>;
}

export interface EngineerAdapter {
  dispatch(mission: Mission, signal: RoutingSignal, request: EngineerDispatch): Promise<void>;
}

export function validateProjectConstitution(value: ProjectConstitution): ProjectConstitution {
  if (value.schema !== "mc.project-constitution/v1") throw new Error("Unsupported project constitution schema");
  if (!value.projectId.trim() || !value.repository.trim() || !value.defaultBranch.trim())
    throw new Error("Project identity, repository, and default branch are required");
  if (!value.architect.adapter.trim() || value.architect.channel !== "CHATGPT" || !value.engineer.adapter.trim())
    throw new Error("Architect and Engineer adapters are required");
  const assigned = new Set<Capability>();
  for (const group of [value.authority.engineer, value.authority.architect, value.authority.ctoRequired]) {
    for (const capability of group) {
      if (!capabilityValues.includes(capability)) throw new Error(`Unsupported capability: ${capability}`);
      if (assigned.has(capability)) throw new Error(`Capability has multiple owners: ${capability}`);
      assigned.add(capability);
    }
  }
  return value;
}

export function validateMission(value: Mission): Mission {
  if (value.schema !== "mc.mission/v1" || !value.missionId.trim() || !value.objective.trim())
    throw new Error("Mission schema, identity, and objective are required");
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error("Mission revision must be positive");
  return value;
}

export function validateRoutingSignal(value: RoutingSignal): RoutingSignal {
  if (!value.missionId.trim() || !Number.isSafeInteger(value.revision) || value.revision < 1)
    throw new Error("Signal mission identity and positive revision are required");
  if (value.schema === "mc.engineer-report/v1" && !value.summary.trim())
    throw new Error("Engineer summary is required");
  if (value.schema === "mc.architect-decision/v1" && !value.rationale.trim())
    throw new Error("Architect rationale is required");
  if (value.schema === "mc.cto-decision/v1" && value.requestRevision < 1)
    throw new Error("CTO decision must bind a request revision");
  return value;
}
