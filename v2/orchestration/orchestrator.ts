import type { MissionStore } from "../github/mission-store";
import type {
  ArchitectDecision,
  CtoDecision,
  CtoRequest,
  EngineerReport,
  Mission,
  ProjectConstitution,
  RoutingSignal,
} from "../routing/contracts";
import type { ProjectConfiguration } from "../runtime/config";
import type { BindingStore, MissionBinding } from "../runtime/bindings";

export type EngineerRunner = {
  run(input: {
    mission: Mission;
    constitution: ProjectConstitution;
    localCheckout: string;
    priorSignal?: RoutingSignal;
    threadId?: string;
  }): Promise<{ report: EngineerReport; threadId: string }>;
};
export type ArchitectRunner = {
  review(input: {
    mission: Mission;
    constitution: ProjectConstitution;
    engineerReport?: EngineerReport;
    priorSignal?: RoutingSignal;
    previousResponseId?: string;
    architectThreadId?: string;
    localCheckout: string;
  }): Promise<{ decision: ArchitectDecision; responseId?: string; architectThreadId?: string }>;
};

export class MissionOrchestrator {
  constructor(
    private readonly project: ProjectConfiguration,
    private readonly store: MissionStore,
    private readonly bindings: BindingStore,
    private readonly engineer: EngineerRunner,
    private readonly architect: ArchitectRunner,
  ) {}

  async advance(issueNumber: number) {
    let current = await this.store.readMission({ issueNumber });
    let binding = await this.binding(current.mission.missionId, issueNumber, current.latestRevision);
    if (
      current.mission.state === "CTO_DECISION" ||
      current.mission.state === "BLOCKED_EXTERNAL" ||
      current.mission.state === "COMPLETE"
    )
      return current;
    if (current.mission.currentActor === "ENGINEER") {
      const key = `${current.mission.missionId}:${current.mission.revision}:engineer`;
      binding = await this.markInFlight(binding, key, "ENGINEER");
      const result = await this.engineer.run({
        mission: current.mission,
        constitution: this.project.constitution,
        localCheckout: this.project.localCheckout,
        priorSignal: this.latestSignal(current),
        threadId: binding.codexThreadId,
      });
      binding = { ...binding, codexThreadId: result.threadId };
      current = await this.store.appendEngineerReport({ issueNumber }, result.report);
      await this.bindings.put({ ...binding, lastProcessedRevision: current.latestRevision, inFlight: undefined });
      return current;
    }
    if (current.mission.currentActor === "ARCHITECT") {
      const key = `${current.mission.missionId}:${current.mission.revision}:architect`;
      binding = await this.markInFlight(binding, key, "ARCHITECT");
      const result = await this.architect.review({
        mission: current.mission,
        constitution: this.project.constitution,
        engineerReport: current.latestEngineerReport,
        priorSignal: this.latestSignal(current),
        previousResponseId: binding.architectResponseId,
        architectThreadId: binding.architectThreadId,
        localCheckout: this.project.localCheckout,
      });
      binding = {
        ...binding,
        ...(result.responseId ? { architectResponseId: result.responseId } : {}),
        ...(result.architectThreadId ? { architectThreadId: result.architectThreadId } : {}),
      };
      current = await this.store.appendArchitectDecision({ issueNumber }, result.decision);
      if (result.decision.decision === "CTO_REQUIRED") {
        const report = current.latestEngineerReport;
        const capability = report?.capabilitiesRequested.find((value) =>
          this.project.constitution.authority.ctoRequired.includes(value),
        );
        if (!report || !capability)
          throw new Error("Architect requested CTO authority without an exact CTO-owned capability");
        const request: CtoRequest = {
          schema: "mc.cto-request/v1",
          missionId: current.mission.missionId,
          revision: current.latestRevision + 1,
          capability,
          action: result.decision.rationale,
          financialEffect: capability === "MOVE_MONEY" ? "Simulated only; no transaction authorized" : "None",
          externalEffect: "Requires exact owner authorization",
          reversible: false,
          architectRecommendation: "APPROVE",
          evidence: [
            { kind: "architect-decision", revision: result.decision.revision },
            { kind: "engineer-report", revision: report.revision },
          ],
          status: "PENDING",
        };
        current = await this.store.appendCtoRequest({ issueNumber }, request);
      }
      await this.bindings.put({ ...binding, lastProcessedRevision: current.latestRevision, inFlight: undefined });
      if (current.mission.state === "COMPLETE") current = await this.store.closeMission({ issueNumber });
      return current;
    }
    throw new Error(`No provider route for actor ${current.mission.currentActor}`);
  }

  async decide(
    issueNumber: number,
    input: { decision: CtoDecision["decision"]; requestRevision: number; comment?: string },
  ) {
    const current = await this.store.readMission({ issueNumber });
    if (current.mission.state !== "CTO_DECISION" || current.pendingCtoRequest?.revision !== input.requestRevision)
      throw new Error("CTO decision is stale or no longer pending");
    const decision: CtoDecision = {
      schema: "mc.cto-decision/v1",
      missionId: current.mission.missionId,
      revision: current.latestRevision + 1,
      requestRevision: input.requestRevision,
      decision: input.decision,
      ...(input.comment ? { comment: input.comment } : {}),
    };
    const result = await this.store.appendCtoDecision({ issueNumber }, decision);
    const binding = await this.binding(result.mission.missionId, issueNumber, result.latestRevision);
    await this.bindings.put({ ...binding, lastProcessedRevision: result.latestRevision });
    return result;
  }

  private latestSignal(current: Awaited<ReturnType<MissionStore["readMission"]>>): RoutingSignal | undefined {
    return (
      current.latestCtoDecision ??
      current.pendingCtoRequest ??
      current.latestArchitectDecision ??
      current.latestEngineerReport
    );
  }
  private async binding(missionId: string, issueNumber: number, revision: number): Promise<MissionBinding> {
    return (
      (await this.bindings.get(missionId)) ?? {
        missionId,
        projectId: this.project.projectId,
        issueNumber,
        lastProcessedRevision: revision,
      }
    );
  }
  private async markInFlight(binding: MissionBinding, idempotencyKey: string, actor: "ENGINEER" | "ARCHITECT") {
    if (binding.inFlight && binding.inFlight.idempotencyKey !== idempotencyKey)
      throw new Error(`Mission has unresolved in-flight dispatch ${binding.inFlight.idempotencyKey}`);
    const next = { ...binding, inFlight: { idempotencyKey, actor, revision: binding.lastProcessedRevision } };
    await this.bindings.put(next);
    return next;
  }
}
