import type {
  ArchitectDecision,
  CtoDecision,
  CtoRequest,
  EngineerReport,
  Mission,
  OwnerReconciliation,
  ProjectConstitution,
} from "../routing/contracts";
import type { ReconciledMission } from "./reconciliation";

export type MissionIssueRef = { issueNumber: number };

export interface MissionStore {
  readMission(ref: MissionIssueRef): Promise<ReconciledMission>;
  appendEngineerReport(ref: MissionIssueRef, report: EngineerReport): Promise<ReconciledMission>;
  appendArchitectDecision(ref: MissionIssueRef, decision: ArchitectDecision): Promise<ReconciledMission>;
  appendCtoRequest(ref: MissionIssueRef, request: CtoRequest): Promise<ReconciledMission>;
  appendCtoDecision(ref: MissionIssueRef, decision: CtoDecision): Promise<ReconciledMission>;
  appendOwnerReconciliation(ref: MissionIssueRef, reconciliation: OwnerReconciliation): Promise<ReconciledMission>;
  updateMissionState(ref: MissionIssueRef, mission: Mission): Promise<void>;
  closeMission(ref: MissionIssueRef): Promise<ReconciledMission>;
  reconcileMission(ref: MissionIssueRef): Promise<ReconciledMission>;
}

export type MissionStoreConfiguration = {
  constitution: ProjectConstitution;
  authorizedLogins: string[];
};
