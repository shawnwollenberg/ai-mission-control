import { createHash } from "node:crypto";
import { routeMission } from "../routing/router";
import type {
  ArchitectDecision,
  CtoRequest,
  EngineerReport,
  Mission,
  ProjectConstitution,
  RoutingSignal,
} from "../routing/contracts";
import { parseMachineComment, parseMissionBody } from "./protocol";

export type GitHubMissionComment = {
  id: number;
  body: string;
  authorLogin: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GitHubMissionIssue = {
  number: number;
  url: string;
  title: string;
  body: string;
  state: "open" | "closed";
  stateReason?: string | null;
  labels: string[];
  authorLogin: string | null;
  comments: GitHubMissionComment[];
};

export type ReconciledMission = {
  mission: Mission;
  latestRevision: number;
  latestEngineerReport?: EngineerReport;
  latestArchitectDecision?: ArchitectDecision;
  pendingCtoRequest?: CtoRequest;
  complete: boolean;
  ignoredHumanCommentIds: number[];
  historyDigest: string;
};

export function reconcileGitHubMission(input: {
  constitution: ProjectConstitution;
  issue: GitHubMissionIssue;
  authorizedLogins: string[];
  enforceLabels?: boolean;
}): ReconciledMission {
  if (!input.issue.labels.includes("mc:mission")) throw new Error("GitHub Issue is missing mc:mission");
  if (!input.issue.authorLogin || !input.authorizedLogins.includes(input.issue.authorLogin))
    throw new Error("Mission envelope author is unauthorized");

  let mission = parseMissionBody(input.issue.body);
  const byRevision = new Map<number, { signal: RoutingSignal; canonical: string }>();
  const ignoredHumanCommentIds: number[] = [];

  for (const comment of input.issue.comments) {
    const signal = parseMachineComment(comment.body);
    if (!signal) {
      ignoredHumanCommentIds.push(comment.id);
      continue;
    }
    if (!comment.authorLogin || !input.authorizedLogins.includes(comment.authorLogin))
      throw new Error(`Machine envelope comment ${comment.id} has an unauthorized author`);
    if (signal.missionId !== mission.missionId) throw new Error(`Comment ${comment.id} belongs to another mission`);
    const canonical = JSON.stringify(signal);
    const existing = byRevision.get(signal.revision);
    if (existing && existing.canonical !== canonical)
      throw new Error(`Conflicting duplicate revision ${signal.revision}`);
    if (!existing) byRevision.set(signal.revision, { signal, canonical });
  }

  let latestEngineerReport: EngineerReport | undefined;
  let latestArchitectDecision: ArchitectDecision | undefined;
  let pendingCtoRequest: CtoRequest | undefined;
  const history = [JSON.stringify(mission)];

  for (const revision of Array.from(byRevision.keys()).sort((left, right) => left - right)) {
    if (revision !== mission.revision + 1) throw new Error(`Revision gap before ${revision}`);
    const signal = byRevision.get(revision)!.signal;
    const result = routeMission({
      constitution: input.constitution,
      mission,
      signal,
      lastProcessedRevision: mission.revision,
      pendingArchitectDecisionRevision:
        latestArchitectDecision?.decision === "CTO_REQUIRED" ? latestArchitectDecision.revision : undefined,
      pendingCtoRequestRevision: pendingCtoRequest?.revision,
    });
    mission = result.mission;
    history.push(JSON.stringify(signal));
    if (signal.schema === "mc.engineer-report/v1") latestEngineerReport = signal;
    if (signal.schema === "mc.architect-decision/v1") latestArchitectDecision = signal;
    if (signal.schema === "mc.cto-request/v1") pendingCtoRequest = signal;
    if (signal.schema === "mc.cto-decision/v1") pendingCtoRequest = undefined;
  }

  const expectedStateLabel = `mc:${mission.state.toLowerCase().replaceAll("_", "-")}`;
  const stateLabels = input.issue.labels.filter((label) => label.startsWith("mc:") && label !== "mc:mission");
  if (input.enforceLabels !== false && (stateLabels.length !== 1 || stateLabels[0] !== expectedStateLabel))
    throw new Error(`Issue must contain exactly the derived state label ${expectedStateLabel}`);
  if (input.issue.state === "closed" && mission.state !== "COMPLETE")
    throw new Error("Issue closed unexpectedly before mission completion");
  if (input.issue.state === "open" && mission.state === "COMPLETE" && input.issue.stateReason === "reopened")
    throw new Error("Completed mission issue was reopened");

  return {
    mission,
    latestRevision: mission.revision,
    ...(latestEngineerReport ? { latestEngineerReport } : {}),
    ...(latestArchitectDecision ? { latestArchitectDecision } : {}),
    ...(pendingCtoRequest ? { pendingCtoRequest } : {}),
    complete: mission.state === "COMPLETE" && input.issue.state === "closed",
    ignoredHumanCommentIds,
    historyDigest: createHash("sha256").update(history.join("\n")).digest("hex"),
  };
}

export function missionStateLabel(mission: Mission) {
  return `mc:${mission.state.toLowerCase().replaceAll("_", "-")}`;
}
