import { createHash } from "node:crypto";
import type {
  ArchitectDecision,
  EngineerReport,
  Mission,
  ProjectConstitution,
  RoutingSignal,
} from "../routing/contracts";

export type WorkerActor = "ARCHITECT" | "ENGINEER";
export type WorkerStatus = "ONLINE" | "OFFLINE" | "AUTH_REQUIRED" | "DEGRADED";

export type WorkerMissionPacket = {
  mission: Mission;
  constitution: ProjectConstitution;
  latestEngineerReport?: EngineerReport;
  priorSignal?: RoutingSignal;
};

export type WorkerDispatch = {
  schema: "mc.worker-dispatch/v1";
  dispatchId: string;
  projectId: string;
  missionId: string;
  issueNumber: number;
  missionRevision: number;
  actor: WorkerActor;
  adapter: string;
  idempotencyKey: string;
  missionDigest: string;
  packet: WorkerMissionPacket;
};

export type WorkerResult = {
  schema: "mc.worker-result/v1";
  dispatchId: string;
  idempotencyKey: string;
  missionId: string;
  missionRevision: number;
  actor: WorkerActor;
  result: EngineerReport | ArchitectDecision;
  providerThreadId: string;
};

export type WorkerHealth = {
  schema: "mc.worker-health/v1";
  workerId: string;
  displayName: string;
  sessionId: string;
  status: Exclude<WorkerStatus, "OFFLINE">;
  currentDispatchId?: string;
  architectAvailable: boolean;
  engineerAvailable: boolean;
};

export function sha256(value: unknown) {
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
}

export function validateWorkerResult(value: WorkerResult, dispatch: WorkerDispatch) {
  if (
    value.schema !== "mc.worker-result/v1" ||
    value.dispatchId !== dispatch.dispatchId ||
    value.idempotencyKey !== dispatch.idempotencyKey ||
    value.missionId !== dispatch.missionId ||
    value.missionRevision !== dispatch.missionRevision ||
    value.actor !== dispatch.actor ||
    value.result.missionId !== dispatch.missionId ||
    value.result.revision !== dispatch.missionRevision + 1 ||
    (dispatch.actor === "ENGINEER" && value.result.schema !== "mc.engineer-report/v1") ||
    (dispatch.actor === "ARCHITECT" && value.result.schema !== "mc.architect-decision/v1")
  )
    throw new Error("Worker result does not match its exact dispatch binding");
  if (!value.providerThreadId?.trim()) throw new Error("Worker result requires a provider thread id");
  return value;
}

export function validateWorkerHealth(value: WorkerHealth) {
  if (
    value.schema !== "mc.worker-health/v1" ||
    !/^[A-Za-z0-9_-]{3,80}$/.test(value.workerId) ||
    !value.displayName?.trim() ||
    !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value.sessionId) ||
    !["ONLINE", "AUTH_REQUIRED", "DEGRADED"].includes(value.status) ||
    typeof value.architectAvailable !== "boolean" ||
    typeof value.engineerAvailable !== "boolean"
  )
    throw new Error("Invalid worker health envelope");
  return value;
}
