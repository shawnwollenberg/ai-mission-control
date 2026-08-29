import {
  validateMission,
  validateProjectConstitution,
  validateRoutingSignal,
  type ArchitectDecision,
  type ArchitectDispatch,
  type CtoDecision,
  type CtoRequest,
  type EngineerDispatch,
  type Mission,
  type ProjectConstitution,
  type RoutingSignal,
} from "./contracts";

export type RoutingResult = {
  outcome: "ROUTED" | "DUPLICATE" | "WAITING" | "COMPLETE" | "BLOCKED";
  mission: Mission;
  processedRevision: number;
  dispatch?: ArchitectDispatch | EngineerDispatch;
  ctoRequest?: CtoRequest;
};

const actorForState: Record<Mission["state"], Mission["currentActor"]> = {
  NEW: "ARCHITECT",
  ARCHITECT_PLANNING: "ARCHITECT",
  ENGINEER_WORKING: "ENGINEER",
  ARCHITECT_REVIEW: "ARCHITECT",
  CTO_DECISION: "CTO",
  BLOCKED_EXTERNAL: "EXTERNAL",
  COMPLETE: "NONE",
};

function advance(mission: Mission, signal: RoutingSignal, state: Mission["state"]): Mission {
  return {
    ...mission,
    revision: signal.revision,
    state,
    currentActor: actorForState[state],
  };
}

function key(missionId: string, revision: number, actor: "ARCHITECT" | "ENGINEER") {
  return `${missionId}:${revision}:${actor.toLowerCase()}`;
}

export function routeMission(input: {
  constitution: ProjectConstitution;
  mission: Mission;
  signal: RoutingSignal;
  lastProcessedRevision: number;
  pendingCtoRequestRevision?: number;
  pendingArchitectDecisionRevision?: number;
}): RoutingResult {
  const constitution = validateProjectConstitution(input.constitution);
  const mission = validateMission(input.mission);
  const signal = validateRoutingSignal(input.signal);

  if (signal.missionId !== mission.missionId) throw new Error("Signal belongs to another mission");
  if (signal.revision <= input.lastProcessedRevision)
    return { outcome: "DUPLICATE", mission, processedRevision: input.lastProcessedRevision };
  if (signal.revision !== mission.revision + 1) throw new Error("Signal revision is not the next mission revision");

  if (mission.state === "ENGINEER_WORKING" && signal.schema === "mc.engineer-report/v1") {
    const next = advance(mission, signal, "ARCHITECT_REVIEW");
    return {
      outcome: "ROUTED",
      mission: next,
      processedRevision: signal.revision,
      dispatch: {
        actor: "ARCHITECT",
        channel: "CHATGPT",
        adapter: constitution.architect.adapter,
        reason: "ENGINEER_REPORT_READY",
        idempotencyKey: key(mission.missionId, signal.revision, "ARCHITECT"),
      },
    };
  }

  if (mission.state === "ARCHITECT_REVIEW" && signal.schema === "mc.architect-decision/v1") {
    return routeArchitectDecision(constitution, mission, signal);
  }

  if (mission.state === "ARCHITECT_REVIEW" && signal.schema === "mc.cto-request/v1") {
    if (!input.pendingArchitectDecisionRevision || signal.revision !== input.pendingArchitectDecisionRevision + 1)
      throw new Error("CTO request does not follow the pending Architect decision");
    if (!constitution.authority.ctoRequired.includes(signal.capability))
      throw new Error("Requested capability does not require CTO authority");
    return {
      outcome: "WAITING",
      mission: advance(mission, signal, "CTO_DECISION"),
      processedRevision: signal.revision,
      ctoRequest: signal,
    };
  }

  if (mission.state === "CTO_DECISION" && signal.schema === "mc.cto-decision/v1") {
    return routeCtoDecision(constitution, mission, signal, input.pendingCtoRequestRevision);
  }

  throw new Error(`Invalid signal ${signal.schema} while mission is ${mission.state}`);
}

function routeArchitectDecision(
  constitution: ProjectConstitution,
  mission: Mission,
  signal: ArchitectDecision,
): RoutingResult {
  if (signal.decision === "APPROVE") {
    if (signal.nextMission) throw new Error("Approval cannot include next work");
    return { outcome: "COMPLETE", mission: advance(mission, signal, "COMPLETE"), processedRevision: signal.revision };
  }
  if (signal.decision === "BLOCKED_EXTERNAL") {
    if (signal.nextMission) throw new Error("External block cannot dispatch work");
    return {
      outcome: "BLOCKED",
      mission: advance(mission, signal, "BLOCKED_EXTERNAL"),
      processedRevision: signal.revision,
    };
  }
  if (signal.decision === "CTO_REQUIRED") {
    if (signal.nextMission) throw new Error("CTO_REQUIRED cannot contain next work");
    return {
      outcome: "WAITING",
      mission: advance(mission, signal, "ARCHITECT_REVIEW"),
      processedRevision: signal.revision,
    };
  }
  if (!signal.nextMission) throw new Error("REMEDIATE must contain next work");
  const next = { ...advance(mission, signal, "ENGINEER_WORKING"), ...signal.nextMission };
  return {
    outcome: "ROUTED",
    mission: next,
    processedRevision: signal.revision,
    dispatch: {
      actor: "ENGINEER",
      adapter: constitution.engineer.adapter,
      reason: "REMEDIATION",
      idempotencyKey: key(mission.missionId, signal.revision, "ENGINEER"),
    },
  };
}

function routeCtoDecision(
  constitution: ProjectConstitution,
  mission: Mission,
  signal: CtoDecision,
  pendingCtoRequestRevision?: number,
): RoutingResult {
  if (!pendingCtoRequestRevision || signal.requestRevision !== pendingCtoRequestRevision)
    throw new Error("CTO decision does not bind the pending request revision");
  if (signal.decision === "APPROVED") {
    const next = advance(mission, signal, "ENGINEER_WORKING");
    return {
      outcome: "ROUTED",
      mission: next,
      processedRevision: signal.revision,
      dispatch: {
        actor: "ENGINEER",
        adapter: constitution.engineer.adapter,
        reason: "CTO_APPROVED",
        idempotencyKey: key(mission.missionId, signal.revision, "ENGINEER"),
      },
    };
  }
  const next = advance(mission, signal, "ARCHITECT_REVIEW");
  return {
    outcome: "ROUTED",
    mission: next,
    processedRevision: signal.revision,
    dispatch: {
      actor: "ARCHITECT",
      channel: "CHATGPT",
      adapter: constitution.architect.adapter,
      reason: signal.decision === "DISCUSS" ? "CTO_DISCUSS" : "CTO_REJECTED",
      idempotencyKey: key(mission.missionId, signal.revision, "ARCHITECT"),
    },
  };
}
