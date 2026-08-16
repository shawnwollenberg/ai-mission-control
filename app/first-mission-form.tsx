"use client";

import { FormEvent, ReactNode, useRef, useState } from "react";
import Link from "next/link";
import { AppNavigation } from "@/app/app-navigation";

type Repository = {
  repository_id: string;
  name: string;
  default_branch: string;
  agent_id: string;
  agent_name: string;
  health_score: number | null;
  health_confidence: number | null;
  health_assessed_at: string | null;
  actionable_recommendations: number;
  agent_ready?: boolean;
};
type PendingApproval = {
  approvalId: string;
  missionId: string;
  missionName: string;
  riskExplanation: string;
};
type RecentMission = {
  missionId: string;
  name: string;
  status: string;
  updatedAt: string;
};
type OpenRecommendation = {
  recommendationId: string;
  title: string;
  repositoryName: string;
  estimatedRisk: string;
};
type PlanningAgent = {
  agent_id: string;
  name: string;
  provider_id: string;
  supported_models: string[];
  capability_attestation_id: string;
  capability_attestation_hash: string;
  model_capabilities: ModelCapability[];
};
type ModelCapability = {
  modelId: string;
  displayName: string;
  provider: string;
  supportedRoles: Array<"planner" | "synthesizer" | "executor" | "implementation_reviewer">;
  supportedOperations: string[];
  structuredOutput: boolean;
  repositoryRead: boolean;
  repositoryMutation: boolean;
  planMode: boolean;
  runtimeModelIdentity: "verified" | "reported" | "unverifiable";
};

function roleModels(agent: PlanningAgent | undefined, role: ModelCapability["supportedRoles"][number]) {
  return (agent?.model_capabilities ?? []).filter((model) => model.supportedRoles.includes(role));
}

type LaunchStage = "intent" | "scope" | "review";
type MissionType = "analysis" | "change" | "consensus";

const missionIntentOptions: Array<{
  value: MissionType;
  title: string;
  description: string;
  boundary: string;
}> = [
  {
    value: "analysis",
    title: "Analyze Repository",
    description: "Analyze this repository's health, architecture, risk, and next steps.",
    boundary: "Read only",
  },
  {
    value: "change",
    title: "Change Repository",
    description: "Prepare a bounded implementation with validation and evidence.",
    boundary: "Approval before writes",
  },
  {
    value: "consensus",
    title: "Consensus plan",
    description: "Have eligible agents independently review an implementation plan.",
    boundary: "Planning before approval",
  },
];

const missionTypeLabels: Record<MissionType, string> = {
  analysis: "Repository analysis",
  change: "Repository change",
  consensus: "Consensus plan",
};

const missionTypeObjectives: Record<MissionType, string> = {
  analysis: "Analyze this repository and produce a concise architecture, risk, and next-steps report",
  change: "Implement a focused repository change and prepare it for review",
  consensus: "Produce a production-ready, approval-bound implementation plan for this repository",
};

function isMissionType(value: string | undefined): value is MissionType {
  return value === "analysis" || value === "change" || value === "consensus";
}

export default function FirstMissionForm({
  repositories,
  planningAgents,
  initialMissionType,
  initialRepositoryId,
  liveLaunchAvailable = true,
  attentionBanner,
  pendingApprovals = [],
  recentMissions = [],
  openRecommendations = [],
}: {
  repositories: Repository[];
  planningAgents: PlanningAgent[];
  initialMissionType?: string;
  initialRepositoryId?: string;
  liveLaunchAvailable?: boolean;
  attentionBanner?: ReactNode;
  pendingApprovals?: PendingApproval[];
  recentMissions?: RecentMission[];
  openRecommendations?: OpenRecommendation[];
}) {
  const startingType = isMissionType(initialMissionType) ? initialMissionType : "analysis";
  const startingRepository =
    repositories.find((repository) => repository.repository_id === initialRepositoryId)?.repository_id ??
    repositories[0]?.repository_id ??
    "";
  const [missionType, setMissionType] = useState<MissionType>(startingType);
  const [stage, setStage] = useState<LaunchStage>(isMissionType(initialMissionType) ? "scope" : "intent");
  const [repositoryId, setRepositoryId] = useState(startingRepository);
  const [objective, setObjective] = useState(missionTypeObjectives[startingType]);
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("");
  const [validationInstructions, setValidationInstructions] = useState("");
  const [constraints, setConstraints] = useState("");
  const plannerAgents = planningAgents.filter((agent) => roleModels(agent, "planner").length);
  const synthesizerAgents = planningAgents.filter((agent) => roleModels(agent, "synthesizer").length);
  const executorAgents = planningAgents.filter((agent) => roleModels(agent, "executor").length);
  const reviewerAgents = planningAgents.filter((agent) => roleModels(agent, "implementation_reviewer").length);
  const [plannerAId, setPlannerAId] = useState(plannerAgents[0]?.agent_id ?? "");
  const [plannerBId, setPlannerBId] = useState(
    plannerAgents.find((agent) => agent.agent_id !== plannerAgents[0]?.agent_id)?.agent_id ?? "",
  );
  const [plannerAModel, setPlannerAModel] = useState(roleModels(plannerAgents[0], "planner")[0]?.modelId ?? "");
  const [plannerBModel, setPlannerBModel] = useState(roleModels(plannerAgents[1], "planner")[0]?.modelId ?? "");
  const [synthesizerId, setSynthesizerId] = useState(synthesizerAgents[0]?.agent_id ?? "");
  const [synthesizerModel, setSynthesizerModel] = useState(
    roleModels(synthesizerAgents[0], "synthesizer")[0]?.modelId ?? "",
  );
  const [executorId, setExecutorId] = useState(executorAgents[0]?.agent_id ?? "");
  const [executorModel, setExecutorModel] = useState(roleModels(executorAgents[0], "executor")[0]?.modelId ?? "");
  const [reviewerId, setReviewerId] = useState(reviewerAgents[0]?.agent_id ?? "");
  const [reviewerModel, setReviewerModel] = useState(
    roleModels(reviewerAgents[0], "implementation_reviewer")[0]?.modelId ?? "",
  );
  const [maximumCost, setMaximumCost] = useState("");
  const [maximumDuration, setMaximumDuration] = useState("3600");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const commandId = useRef(crypto.randomUUID());
  const selected = repositories.find((repository) => repository.repository_id === repositoryId);
  const plannerA = planningAgents.find((agent) => agent.agent_id === plannerAId);
  const plannerB = planningAgents.find((agent) => agent.agent_id === plannerBId);
  const synthesizer = planningAgents.find((agent) => agent.agent_id === synthesizerId);
  const executor = planningAgents.find((agent) => agent.agent_id === executorId);
  const reviewer = planningAgents.find((agent) => agent.agent_id === reviewerId);
  const stageIndex = stage === "intent" ? 0 : stage === "scope" ? 1 : 2;
  const canReview = Boolean(selected && objective.trim());
  const consensusReady =
    missionType !== "consensus" ||
    Boolean(
      acceptanceCriteria.trim() &&
      plannerAId &&
      plannerBId &&
      plannerAId !== plannerBId &&
      plannerAModel &&
      plannerBModel &&
      synthesizerId &&
      synthesizerModel &&
      executorId &&
      executorModel,
    );

  function chooseMissionType(next: MissionType) {
    setMissionType(next);
    setObjective(missionTypeObjectives[next]);
    setError("");
  }

  function continueToScope() {
    setError("");
    setStage("scope");
  }

  function continueToReview() {
    if (!selected) {
      setError("Select a registered repository before reviewing the mission.");
      return;
    }
    if (!objective.trim()) {
      setError("Add an objective before reviewing the mission.");
      return;
    }
    setError("");
    setStage("review");
  }

  async function launch(event: FormEvent) {
    event.preventDefault();
    if (stage !== "review" || !selected || pending) return;
    if (!liveLaunchAvailable || selected.agent_ready === false) {
      setError("Reconnect Mission Agent before launching a live repository mission.");
      return;
    }
    setPending(true);
    setError("");
    const response = await fetch(
      missionType === "consensus" ? "/api/consensus-plans" : "/api/onboarding/first-mission",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": commandId.current },
        body: JSON.stringify(
          missionType === "consensus"
            ? {
                repositoryId,
                baseBranch: selected.default_branch,
                objective,
                acceptanceCriteria: acceptanceCriteria
                  .split("\n")
                  .map((item) => item.trim())
                  .filter(Boolean),
                constraints: constraints
                  .split("\n")
                  .map((item) => item.trim())
                  .filter(Boolean),
                plannerA: { agentId: plannerAId, modelId: plannerAModel },
                plannerB: { agentId: plannerBId, modelId: plannerBModel },
                synthesizer: { agentId: synthesizerId, modelId: synthesizerModel },
                preferredExecutorAgentId: executorId,
                preferredExecutorModelId: executorModel,
                implementationReviewer:
                  reviewerId && reviewerModel ? { agentId: reviewerId, modelId: reviewerModel } : undefined,
                maximumCostAmount: maximumCost ? Number(maximumCost) : undefined,
                maximumDurationSeconds: Number(maximumDuration),
              }
            : {
                repositoryId,
                agentId: selected.agent_id,
                missionType,
                objective,
                acceptanceCriteria,
                validationInstructions,
              },
        ),
      },
    );
    const body = (await response.json()) as { missionId?: string; error?: { message?: string } };
    if (response.ok && body.missionId) window.location.assign(`/missions/${body.missionId}`);
    else {
      setError(body.error?.message ?? "The mission could not be launched.");
      setPending(false);
    }
  }
  return (
    <main className="launch-shell">
      <AppNavigation subtitle="New mission" />
      {attentionBanner}
      {(pendingApprovals.length > 0 || openRecommendations.length > 0 || recentMissions.length > 0) && (
        <section className="home-attention-board" aria-label="What needs you">
          {pendingApprovals.length > 0 && (
            <article className="home-attention-panel home-attention-urgent">
              <p className="section-label">Needs you</p>
              <h2>
                {pendingApprovals.length} approval{pendingApprovals.length === 1 ? "" : "s"} waiting
              </h2>
              <ul>
                {pendingApprovals.map((approval) => (
                  <li key={approval.approvalId}>
                    <Link href={`/missions/${approval.missionId}`}>
                      <strong>{approval.missionName}</strong>
                      <small>{approval.riskExplanation}</small>
                    </Link>
                  </li>
                ))}
              </ul>
              <Link href="/approvals">Open approvals →</Link>
            </article>
          )}
          {openRecommendations.length > 0 && (
            <article className="home-attention-panel">
              <p className="section-label">Next work</p>
              <h2>
                {openRecommendations.length} open recommendation{openRecommendations.length === 1 ? "" : "s"}
              </h2>
              <ul>
                {openRecommendations.map((recommendation) => (
                  <li key={recommendation.recommendationId}>
                    <Link href={`/recommendations/${recommendation.recommendationId}`}>
                      <strong>{recommendation.title}</strong>
                      <small>
                        {recommendation.repositoryName} · {recommendation.estimatedRisk} risk
                      </small>
                    </Link>
                  </li>
                ))}
              </ul>
            </article>
          )}
          {recentMissions.length > 0 && (
            <article className="home-attention-panel">
              <p className="section-label">Recent missions</p>
              <h2>Pick up where you left off</h2>
              <ul>
                {recentMissions.map((mission) => (
                  <li key={mission.missionId}>
                    <Link href={`/missions/${mission.missionId}`}>
                      <strong>{mission.name}</strong>
                      <small>
                        {mission.status} · {new Date(mission.updatedAt).toLocaleString()}
                      </small>
                    </Link>
                  </li>
                ))}
              </ul>
              <Link href="/missions">All missions →</Link>
            </article>
          )}
        </section>
      )}
      <section className="repository-dashboard">
        <div className="panel-heading">
          <div>
            <p className="section-label">Your repositories</p>
            <h2>Repositories</h2>
          </div>
          <div className="repository-heading-actions">
            <span className="repository-count">{repositories.length} connected</span>
            <details className="repository-add-help">
              <summary>Add repository</summary>
              <div>
                <strong>Run this on the computer hosting Mission Agent</strong>
                <code>mission-agent repository add /absolute/path/to/repository</code>
                <p>
                  The signed Mission Agent validates the local checkout and registers it only with this workspace. Git
                  credentials stay on that computer.
                </p>
                <p>
                  Folders named <code>mission/*</code> are isolated mission worktrees—not additional repository
                  connections.
                </p>
              </div>
            </details>
            <Link className="nav-link" href="/preview/servicepilot">
              Run Demo
            </Link>
          </div>
        </div>
        <div className="repository-card-grid">
          {repositories.map((repository) => (
            <article className="repository-launch-card" key={repository.repository_id}>
              <Link href={`/repositories/${repository.repository_id}`}>
                <span>
                  {repository.name} · {repository.default_branch}
                  {repository.agent_ready === false ? " · agent offline" : ""}
                </span>
                <strong>
                  {repository.health_score ?? "—"}
                  <small>/ 100</small>
                </strong>
                <p>{repository.actionable_recommendations} open recommendations</p>
                <small>
                  {repository.health_assessed_at
                    ? `${repository.health_confidence}% confidence · ${new Date(repository.health_assessed_at).toLocaleDateString()}`
                    : "Run an analysis to establish health"}
                </small>
              </Link>
              <div className="repository-card-missions">
                <Link href={`/?type=analysis&repository=${repository.repository_id}`}>Analyze</Link>
                <Link href={`/?type=change&repository=${repository.repository_id}`}>Change</Link>
                <Link href={`/?type=consensus&repository=${repository.repository_id}`}>Consensus</Link>
              </div>
            </article>
          ))}
        </div>
      </section>
      <section className="launch-grid">
        <div className="launch-copy">
          <p className="section-label">New mission · Step {stageIndex + 1} of 3</p>
          <h1>
            {stage === "intent"
              ? "What should the organization deliver?"
              : stage === "scope"
                ? "Give the mission a clear target."
                : "Review the mission before launch."}
          </h1>
          <p className="lede">
            {stage === "intent"
              ? "Start with the outcome. Mission Control will only ask for the repository and execution details needed for that kind of work."
              : stage === "scope"
                ? "Choose the repository, write the objective, and define the evidence that will make the result useful."
                : "Confirm the repository, objective, and approval boundary before launching the mission."}
          </p>
          <div className="principle">
            {missionType === "consensus"
              ? "Two agents propose a plan. You approve it before any files change."
              : missionType === "change"
                ? "Local change only. Push, pull request, merge, deployment, and secrets remain unavailable."
                : "Read only. No repository changes."}
          </div>
        </div>
        <form className="launch-card" onSubmit={launch}>
          <div className="launch-stepper" aria-label="New mission setup progress">
            {[
              ["intent", "Intent"],
              ["scope", "Scope"],
              ["review", "Review"],
            ].map(([value, label], index) => (
              <button
                className={`${stage === value ? "is-active" : ""}${stageIndex > index ? " is-complete" : ""}`}
                disabled={index > stageIndex}
                key={value}
                onClick={() => setStage(value as LaunchStage)}
                type="button"
              >
                <span>{index + 1}</span>
                {label}
              </button>
            ))}
          </div>
          <div className="card-heading">
            <span>{missionTypeLabels[missionType]}</span>
            <span className="secure">Live repository mission · local execution</span>
          </div>
          {stage === "scope" && (
            <>
              {repositories.length ? (
                <label>
                  Registered repository
                  <select value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)}>
                    {repositories.map((repository) => (
                      <option value={repository.repository_id} key={repository.repository_id}>
                        {repository.name} · {repository.default_branch} · {repository.agent_name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <div className="form-error">
                  This repository has not been registered with your Mission Agent. Add it from that computer with
                  <code>mission-agent repository add /absolute/path/to/repository</code>.
                </div>
              )}
              <label>
                {missionType === "consensus"
                  ? "Planning objective"
                  : missionType === "change"
                    ? "Change objective"
                    : "Analysis objective"}
                <textarea
                  value={objective}
                  maxLength={1000}
                  onChange={(event) => setObjective(event.target.value)}
                  rows={3}
                />
                <small>
                  {missionType === "consensus"
                    ? "Both planners receive this same objective and acceptance criteria."
                    : missionType === "change"
                      ? "Codex will propose a plan before requesting permission to modify an isolated worktree."
                      : "Analysis missions can investigate and recommend changes, but cannot modify files."}
                </small>
              </label>
              {(missionType === "change" || missionType === "consensus") && (
                <>
                  <label>
                    Acceptance criteria{" "}
                    <small>{missionType === "consensus" ? "Required" : "Optional"} · one item per line</small>
                    <textarea
                      value={acceptanceCriteria}
                      maxLength={3000}
                      onChange={(event) => setAcceptanceCriteria(event.target.value)}
                      placeholder={"Behavior works as described\nRelevant tests are updated"}
                      rows={3}
                    />
                  </label>
                  {missionType === "change" && (
                    <label>
                      Validation commands <small>Optional · one approved repository-local command per line</small>
                      <textarea
                        value={validationInstructions}
                        maxLength={2000}
                        onChange={(event) => setValidationInstructions(event.target.value)}
                        placeholder={"npm test\nnpm run lint\nnpm run typecheck"}
                        rows={3}
                      />
                    </label>
                  )}
                </>
              )}
            </>
          )}
          {stage === "intent" && (
            <div className="mission-intent-grid" aria-label="Mission intent">
              {missionIntentOptions.map((option) => (
                <button
                  className={`mission-intent-card${missionType === option.value ? " is-selected" : ""}`}
                  key={option.value}
                  onClick={() => chooseMissionType(option.value)}
                  type="button"
                >
                  <span className="mission-intent-card-top">
                    <strong>{option.title}</strong>
                    <small>{option.boundary}</small>
                  </span>
                  <p>{option.description}</p>
                </button>
              ))}
            </div>
          )}
          {stage === "review" && (
            <section className="mission-review-summary" aria-label="Mission review">
              <div>
                <span>Mission type</span>
                <strong>{missionTypeLabels[missionType]}</strong>
                <small>
                  {missionType === "consensus"
                    ? "Planning before approval"
                    : missionType === "change"
                      ? "Approval before writes"
                      : "Read only"}
                </small>
              </div>
              <div>
                <span>Repository</span>
                <strong>{selected?.name ?? "Not selected"}</strong>
                <small>
                  {selected ? `${selected.default_branch} · ${selected.agent_name}` : "Choose a repository"}
                </small>
              </div>
              <div className="mission-review-wide">
                <span>Objective</span>
                <p>{objective || "No objective provided"}</p>
              </div>
              {missionType !== "analysis" && (
                <div className="mission-review-wide">
                  <span>Acceptance criteria</span>
                  <p>{acceptanceCriteria.trim() || "No additional criteria provided"}</p>
                </div>
              )}
              {missionType === "change" && (
                <div className="mission-review-wide">
                  <span>Validation commands</span>
                  <p>{validationInstructions.trim() || "No additional commands provided"}</p>
                </div>
              )}
              {missionType === "consensus" && (
                <>
                  <div>
                    <span>Planner 1</span>
                    <strong>{plannerA?.name ?? "Not selected"}</strong>
                    <small>
                      {roleModels(plannerA, "planner").find((model) => model.modelId === plannerAModel)?.displayName ||
                        plannerAModel ||
                        "Choose a model"}
                    </small>
                  </div>
                  <div>
                    <span>Planner 2</span>
                    <strong>{plannerB?.name ?? "Not selected"}</strong>
                    <small>
                      {roleModels(plannerB, "planner").find((model) => model.modelId === plannerBModel)?.displayName ||
                        plannerBModel ||
                        "Choose a model"}
                    </small>
                  </div>
                  <div>
                    <span>Combines the plans</span>
                    <strong>{synthesizer?.name ?? "Not selected"}</strong>
                    <small>
                      {roleModels(synthesizer, "synthesizer").find((model) => model.modelId === synthesizerModel)
                        ?.displayName ||
                        synthesizerModel ||
                        "Choose a model"}
                    </small>
                  </div>
                  <div>
                    <span>Implements after approval</span>
                    <strong>{executor?.name ?? "Not selected"}</strong>
                    <small>
                      {roleModels(executor, "executor").find((model) => model.modelId === executorModel)?.displayName ||
                        executorModel ||
                        "Choose a model"}
                    </small>
                  </div>
                </>
              )}
            </section>
          )}
          {stage === "review" && missionType === "consensus" && (
            <details className="launch-advanced-settings">
              <summary>
                Choose the crew <small>Optional reviewer and cost limits</small>
              </summary>
              <div className="launch-advanced-settings-body">
                <label>
                  Constraints <small>Optional · one item per line</small>
                  <textarea
                    value={constraints}
                    maxLength={3000}
                    onChange={(event) => setConstraints(event.target.value)}
                    rows={3}
                  />
                </label>
                <label>
                  Planner 1
                  <select
                    value={plannerAId}
                    onChange={(event) => {
                      const agent = plannerAgents.find((item) => item.agent_id === event.target.value);
                      setPlannerAId(event.target.value);
                      setPlannerAModel(roleModels(agent, "planner")[0]?.modelId ?? "");
                    }}
                  >
                    {plannerAgents.map((agent) => (
                      <option value={agent.agent_id} key={agent.agent_id}>
                        {agent.name} · {agent.provider_id}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Planner 1 model
                  <select value={plannerAModel} onChange={(event) => setPlannerAModel(event.target.value)}>
                    {roleModels(plannerA, "planner").map((model) => (
                      <option value={model.modelId} key={model.modelId}>
                        {plannerA?.provider_id} — {model.displayName} ({model.modelId})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Planner 2
                  <select
                    value={plannerBId}
                    onChange={(event) => {
                      const agent = plannerAgents.find((item) => item.agent_id === event.target.value);
                      setPlannerBId(event.target.value);
                      setPlannerBModel(roleModels(agent, "planner")[0]?.modelId ?? "");
                    }}
                  >
                    {plannerAgents.map((agent) => (
                      <option value={agent.agent_id} key={agent.agent_id}>
                        {agent.name} · {agent.provider_id}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Planner 2 model
                  <select value={plannerBModel} onChange={(event) => setPlannerBModel(event.target.value)}>
                    {roleModels(plannerB, "planner").map((model) => (
                      <option value={model.modelId} key={model.modelId}>
                        {plannerB?.provider_id} — {model.displayName} ({model.modelId})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Combines the plans
                  <select
                    value={synthesizerId}
                    onChange={(event) => {
                      const agent = synthesizerAgents.find((item) => item.agent_id === event.target.value);
                      setSynthesizerId(event.target.value);
                      setSynthesizerModel(roleModels(agent, "synthesizer")[0]?.modelId ?? "");
                    }}
                  >
                    {synthesizerAgents.map((agent) => (
                      <option value={agent.agent_id} key={agent.agent_id}>
                        {agent.name} · {agent.provider_id}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Combine-plans model
                  <select value={synthesizerModel} onChange={(event) => setSynthesizerModel(event.target.value)}>
                    {roleModels(synthesizer, "synthesizer").map((model) => (
                      <option value={model.modelId} key={model.modelId}>
                        {synthesizer?.provider_id} — {model.displayName} ({model.modelId})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Implements after approval
                  <select
                    value={executorId}
                    onChange={(event) => {
                      const agent = executorAgents.find((item) => item.agent_id === event.target.value);
                      setExecutorId(event.target.value);
                      setExecutorModel(roleModels(agent, "executor")[0]?.modelId ?? "");
                    }}
                  >
                    {executorAgents.map((agent) => (
                      <option value={agent.agent_id} key={agent.agent_id}>
                        {agent.name} · {agent.provider_id}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Implementation model
                  <select value={executorModel} onChange={(event) => setExecutorModel(event.target.value)}>
                    {roleModels(executor, "executor").map((model) => (
                      <option value={model.modelId} key={model.modelId}>
                        {executor?.provider_id} — {model.displayName} ({model.modelId})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Reviewer <small>Optional · recorded only</small>
                  <select
                    value={reviewerId}
                    onChange={(event) => {
                      const agent = reviewerAgents.find((item) => item.agent_id === event.target.value);
                      setReviewerId(event.target.value);
                      setReviewerModel(roleModels(agent, "implementation_reviewer")[0]?.modelId ?? "");
                    }}
                  >
                    <option value="">No reviewer</option>
                    {reviewerAgents.map((agent) => (
                      <option value={agent.agent_id} key={agent.agent_id}>
                        {agent.name} · {agent.provider_id}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Reviewer model
                  <select
                    disabled={!reviewerId}
                    value={reviewerModel}
                    onChange={(event) => setReviewerModel(event.target.value)}
                  >
                    {roleModels(reviewer, "implementation_reviewer").map((model) => (
                      <option value={model.modelId} key={model.modelId}>
                        {reviewer?.provider_id} — {model.displayName} ({model.modelId})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Cost limit <small>Optional USD stop</small>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={maximumCost}
                    onChange={(event) => setMaximumCost(event.target.value)}
                  />
                </label>
                <label>
                  Time limit
                  <select value={maximumDuration} onChange={(event) => setMaximumDuration(event.target.value)}>
                    <option value="1800">30 minutes</option>
                    <option value="3600">1 hour</option>
                    <option value="7200">2 hours</option>
                  </select>
                </label>
              </div>
            </details>
          )}
          {stage === "review" && (
            <ul>
              {missionType === "consensus" ? (
                <>
                  <li>Two agents independently propose a plan</li>
                  <li>They critique each other once</li>
                  <li>You approve the chosen plan before any files change</li>
                  <li>Implementation uses an isolated branch and local commit only</li>
                </>
              ) : missionType === "change" ? (
                <>
                  <li>Plan and request explicit write approval</li>
                  <li>Use an isolated mission branch and worktree</li>
                  <li>Record validation, diff, and local commit evidence</li>
                  <li>No push, pull request, merge, deployment, or secrets</li>
                </>
              ) : (
                <>
                  <li>Inspect files and configuration</li>
                  <li>Review test setup</li>
                  <li>Produce checksummed Markdown</li>
                  <li>No edits, installs, commits, pushes, or deployments</li>
                </>
              )}
            </ul>
          )}
          {stage === "review" && missionType === "consensus" && !consensusReady && (
            <p className="launch-gate-note" role="status">
              Add acceptance criteria, then choose two different planners, who combines the plans, and who implements
              after you approve.
            </p>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="launch-navigation">
            {stage !== "intent" && (
              <button
                className="button-secondary"
                onClick={() => setStage(stage === "review" ? "scope" : "intent")}
                type="button"
              >
                ← Back
              </button>
            )}
            {stage === "intent" && (
              <button className="button-primary" onClick={continueToScope} type="button">
                Continue to scope →
              </button>
            )}
            {stage === "scope" && (
              <button className="button-primary" disabled={!canReview} onClick={continueToReview} type="button">
                Review mission →
              </button>
            )}
            {stage === "review" && (
              <button
                className="launch-button"
                disabled={!selected || !objective.trim() || pending || !consensusReady}
                type="submit"
              >
                {pending
                  ? "Launching mission…"
                  : missionType === "consensus"
                    ? "Launch consensus mission"
                    : missionType === "change"
                      ? "Launch change mission"
                      : "Launch analysis mission"}
                <span>→</span>
              </button>
            )}
          </div>
        </form>
      </section>
    </main>
  );
}
