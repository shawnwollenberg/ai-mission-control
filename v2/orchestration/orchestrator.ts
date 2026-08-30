import type { MissionStore } from "../github/mission-store";
import type {
  ArchitectDecision,
  CtoDecision,
  CtoRequest,
  EngineerReport,
  Mission,
  OwnerMissionAmendment,
  OwnerReconciliation,
  ProjectConstitution,
  RoutingSignal,
} from "../routing/contracts";
import type { ProjectConfiguration } from "../runtime/config";
import type { BindingStore, MissionBinding } from "../runtime/bindings";
import { classifyProviderFailure, operationalLog, V2OperationalError } from "../runtime/operational-errors";

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
    const current = await this.store.readMission({ issueNumber });
    let binding = await this.binding(current.mission.missionId, issueNumber, current.latestRevision);
    if (binding.sourceMissionDigest && binding.sourceMissionDigest !== current.sourceMissionDigest)
      throw new V2OperationalError("MISSION_SOURCE_CHANGED");
    if (binding.inFlight) return this.recoverInFlight(issueNumber, current, binding);
    if (
      current.mission.state === "CTO_DECISION" ||
      current.mission.state === "BLOCKED_EXTERNAL" ||
      current.mission.state === "COMPLETE"
    )
      return current;
    if (current.mission.currentActor === "ENGINEER") {
      const key = `${current.mission.missionId}:${current.mission.revision}:engineer`;
      binding = await this.markInFlight(binding, key, "ENGINEER", current.mission.revision);
      try {
        const result = await this.engineer.run({
          mission: current.mission,
          constitution: this.project.constitution,
          localCheckout: this.project.localCheckout,
          priorSignal: this.latestSignal(current),
          threadId: binding.codexThreadId,
        });
        binding = await this.bindings.update(current.mission.missionId, (stored) => ({
          ...(stored ?? binding),
          codexThreadId: result.threadId,
          failure: undefined,
          inFlight: { ...binding.inFlight!, result: result.report, providerThreadId: result.threadId },
        }));
        return this.recoverInFlight(issueNumber, current, binding);
      } catch (error) {
        await this.recordFailure(binding, error, "ENGINEER", current.mission.revision);
        throw error;
      }
    }
    if (current.mission.currentActor === "ARCHITECT") {
      const key = `${current.mission.missionId}:${current.mission.revision}:architect`;
      binding = await this.markInFlight(binding, key, "ARCHITECT", current.mission.revision);
      try {
        const result = await this.architect.review({
          mission: current.mission,
          constitution: this.project.constitution,
          engineerReport: current.latestEngineerReport,
          priorSignal: this.latestSignal(current),
          previousResponseId: binding.architectResponseId,
          architectThreadId: binding.architectThreadId,
          localCheckout: this.project.localCheckout,
        });
        binding = await this.bindings.update(current.mission.missionId, (stored) => ({
          ...(stored ?? binding),
          ...(result.responseId ? { architectResponseId: result.responseId } : {}),
          ...(result.architectThreadId ? { architectThreadId: result.architectThreadId } : {}),
          failure: undefined,
          inFlight: {
            ...binding.inFlight!,
            result: result.decision,
            ...(result.architectThreadId ? { providerThreadId: result.architectThreadId } : {}),
          },
        }));
        return this.recoverInFlight(issueNumber, current, binding);
      } catch (error) {
        await this.recordFailure(binding, error, "ARCHITECT", current.mission.revision);
        throw error;
      }
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

  async reconcileExternalBlock(
    issueNumber: number,
    input: { blockedRevision: number; reason: string; evidence: OwnerReconciliation["evidence"] },
  ) {
    const current = await this.store.readMission({ issueNumber });
    if (current.mission.state !== "BLOCKED_EXTERNAL" || current.latestRevision !== input.blockedRevision)
      throw new Error("Owner reconciliation is stale or the mission is not externally blocked");
    const reconciliation: OwnerReconciliation = {
      schema: "mc.owner-reconciliation/v1",
      missionId: current.mission.missionId,
      revision: current.latestRevision + 1,
      blockedRevision: input.blockedRevision,
      reason: input.reason,
      evidence: input.evidence,
    };
    const result = await this.store.appendOwnerReconciliation({ issueNumber }, reconciliation);
    const binding = await this.binding(result.mission.missionId, issueNumber, result.latestRevision);
    await this.bindings.put({ ...binding, lastProcessedRevision: result.latestRevision });
    return result;
  }

  async amendBlockedMission(
    issueNumber: number,
    input: {
      blockedRevision: number;
      reason: string;
      replacementAcceptanceCriteria: string[];
      evidence: OwnerMissionAmendment["evidence"];
    },
  ) {
    const current = await this.store.readMission({ issueNumber });
    if (current.mission.state !== "BLOCKED_EXTERNAL" || current.latestRevision !== input.blockedRevision)
      throw new Error("Owner Mission amendment is stale or the mission is not externally blocked");
    const amendment: OwnerMissionAmendment = {
      schema: "mc.owner-mission-amendment/v1",
      missionId: current.mission.missionId,
      revision: current.latestRevision + 1,
      blockedRevision: input.blockedRevision,
      reason: input.reason,
      replacementAcceptanceCriteria: input.replacementAcceptanceCriteria,
      evidence: input.evidence,
    };
    const result = await this.store.appendOwnerMissionAmendment({ issueNumber }, amendment);
    const binding = await this.binding(result.mission.missionId, issueNumber, result.latestRevision);
    await this.bindings.put({ ...binding, lastProcessedRevision: result.latestRevision });
    return result;
  }

  async retryReadOnlyArchitect(issueNumber: number) {
    const current = await this.store.readMission({ issueNumber });
    const binding = await this.binding(current.mission.missionId, issueNumber, current.latestRevision);
    if (binding.inFlight?.actor !== "ARCHITECT" || binding.inFlight.result || !binding.failure)
      throw new Error("No failed read-only Architect dispatch is available for replacement");
    await this.bindings.update(binding.missionId, (stored) => ({
      ...(stored ?? binding),
      architectThreadId: undefined,
      inFlight: undefined,
      failure: undefined,
    }));
    operationalLog({
      event: "provider.read_only_replacement_authorized",
      missionId: binding.missionId,
      revision: current.latestRevision,
      actor: "ARCHITECT",
    });
  }

  private latestSignal(current: Awaited<ReturnType<MissionStore["readMission"]>>): RoutingSignal | undefined {
    return [
      current.latestCtoDecision,
      current.latestOwnerReconciliation,
      current.latestOwnerMissionAmendment,
      current.pendingCtoRequest,
      current.latestArchitectDecision,
      current.latestEngineerReport,
    ]
      .filter((signal): signal is RoutingSignal => signal !== undefined)
      .sort((left, right) => right.revision - left.revision)[0];
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
  private async recoverInFlight(
    issueNumber: number,
    current: Awaited<ReturnType<MissionStore["readMission"]>>,
    binding: MissionBinding,
  ) {
    const dispatch = binding.inFlight!;
    if (!dispatch.result) {
      const error = new V2OperationalError("PROVIDER_DISPATCH_INDETERMINATE");
      await this.recordFailure(binding, error, dispatch.actor, dispatch.revision);
      throw error;
    }
    let next = current;
    if (next.latestRevision < dispatch.result.revision) {
      next =
        dispatch.result.schema === "mc.engineer-report/v1"
          ? await this.store.appendEngineerReport({ issueNumber }, dispatch.result)
          : await this.store.appendArchitectDecision({ issueNumber }, dispatch.result);
    }
    if (
      dispatch.result.schema === "mc.architect-decision/v1" &&
      dispatch.result.decision === "CTO_REQUIRED" &&
      next.latestRevision === dispatch.result.revision
    ) {
      next = await this.appendCtoRequest(issueNumber, next, dispatch.result);
    }
    if (next.mission.state === "COMPLETE" && !next.complete) next = await this.store.closeMission({ issueNumber });
    await this.bindings.update(binding.missionId, (stored) => ({
      ...(stored ?? binding),
      lastProcessedRevision: next.latestRevision,
      inFlight: undefined,
      failure: undefined,
    }));
    operationalLog({
      event: "provider.result_committed",
      missionId: binding.missionId,
      revision: next.latestRevision,
      actor: dispatch.actor,
      idempotencyKey: dispatch.idempotencyKey,
      providerThreadId: dispatch.providerThreadId,
      resultState: next.mission.state,
    });
    return next;
  }

  private async appendCtoRequest(
    issueNumber: number,
    current: Awaited<ReturnType<MissionStore["readMission"]>>,
    decision: ArchitectDecision,
  ) {
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
      action: decision.rationale,
      financialEffect: capability === "MOVE_MONEY" ? "Simulated only; no transaction authorized" : "None",
      externalEffect: "Requires exact owner authorization",
      reversible: false,
      architectRecommendation: "APPROVE",
      evidence: [
        { kind: "architect-decision", revision: decision.revision },
        { kind: "engineer-report", revision: report.revision },
      ],
      status: "PENDING",
    };
    return this.store.appendCtoRequest({ issueNumber }, request);
  }

  private async recordFailure(
    binding: MissionBinding,
    error: unknown,
    actor: "ENGINEER" | "ARCHITECT",
    revision: number,
  ) {
    const failure = classifyProviderFailure(error, actor, revision);
    await this.bindings.update(binding.missionId, (stored) => ({ ...(stored ?? binding), failure }));
    operationalLog({
      event: "provider.dispatch_failed",
      missionId: binding.missionId,
      revision,
      actor,
      idempotencyKey: binding.inFlight?.idempotencyKey,
      failureCode: failure.code,
    });
  }

  private async markInFlight(
    binding: MissionBinding,
    idempotencyKey: string,
    actor: "ENGINEER" | "ARCHITECT",
    revision: number,
  ) {
    const next = await this.bindings.update(binding.missionId, (stored) => {
      const current = stored ?? binding;
      if (current.inFlight) throw new V2OperationalError("PROVIDER_DISPATCH_INDETERMINATE");
      return {
        ...current,
        sourceMissionDigest: current.sourceMissionDigest ?? binding.sourceMissionDigest,
        failure: undefined,
        inFlight: { idempotencyKey, actor, revision },
      };
    });
    operationalLog({
      event: "provider.dispatch_started",
      missionId: binding.missionId,
      revision,
      actor,
      idempotencyKey,
    });
    return next;
  }
}
