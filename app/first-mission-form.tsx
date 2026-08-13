"use client";

import { FormEvent, useRef, useState } from "react";
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
export default function FirstMissionForm({
  repositories,
  planningAgents,
}: {
  repositories: Repository[];
  planningAgents: PlanningAgent[];
}) {
  const [missionType, setMissionType] = useState<"analysis" | "change" | "consensus">("analysis");
  const [repositoryId, setRepositoryId] = useState(repositories[0]?.repository_id ?? "");
  const [objective, setObjective] = useState(
    "Analyze this repository and produce a concise architecture, risk, and next-steps report",
  );
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
  async function launch(event: FormEvent) {
    event.preventDefault();
    if (!selected || pending) return;
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
      <AppNavigation subtitle="New Mission · Live Mission Agent" />
      <section className="repository-dashboard">
        <div className="panel-heading">
          <div>
            <p className="section-label">Daily control plane</p>
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
            <Link href={`/repositories/${repository.repository_id}`} key={repository.repository_id}>
              <span>
                {repository.name} · {repository.default_branch}
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
          ))}
        </div>
      </section>
      <section className="launch-grid">
        <div className="launch-copy">
          <p className="section-label">Live repository mission</p>
          <h1>
            {missionType === "consensus"
              ? "Build an independently reviewed implementation plan."
              : missionType === "change"
                ? "Prepare a controlled repository change."
                : "Direct a repository analysis."}
          </h1>
          <p className="lede">
            {missionType === "consensus"
              ? "Two eligible Mission Agents receive the same immutable repository and Project Brain context, then propose, critique, revise, and issue verdicts on the exact canonical plan before your approval."
              : missionType === "change"
                ? "Codex will plan first, pause for your approval, then work in an isolated local branch and return diff, validation, and commit evidence."
                : "Your local Codex adapter will pull this assignment over outbound HTTPS and return a genuine Markdown artifact."}
          </p>
          <div className="principle">
            {missionType === "consensus"
              ? "Planning is read-only. Your exact approval binds the selected executor to an isolated local implementation mission; push, pull request, merge, and deployment stay prohibited."
              : missionType === "change"
                ? "Local change only. Push, pull request, merge, and deployment remain unavailable."
                : "Read only. No repository changes."}
          </div>
        </div>
        <form className="launch-card" onSubmit={launch}>
          <div className="card-heading">
            <span>
              {missionType === "consensus"
                ? "Consensus plan"
                : missionType === "change"
                  ? "Repository change"
                  : "Repository analysis"}
            </span>
            <span className="secure">Live local execution</span>
          </div>
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
            Mission type
            <select
              value={missionType}
              onChange={(event) => {
                const next = event.target.value as "analysis" | "change" | "consensus";
                setMissionType(next);
                setObjective(
                  next === "consensus"
                    ? "Produce a production-ready, approval-bound implementation plan for this repository"
                    : next === "change"
                      ? "Implement a focused repository change and prepare it for review"
                      : "Analyze this repository and produce a concise architecture, risk, and next-steps report",
                );
              }}
            >
              <option value="analysis">Analyze Repository</option>
              <option value="change">Change Repository</option>
              <option value="consensus">Consensus Plan</option>
            </select>
          </label>
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
                ? "Both planners receive this exact objective, acceptance criteria, constraints, snapshot, and context hash."
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
          {missionType === "consensus" && (
            <>
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
                Planner A
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
                Planner A model
                <select value={plannerAModel} onChange={(event) => setPlannerAModel(event.target.value)}>
                  {roleModels(plannerA, "planner").map((model) => (
                    <option value={model.modelId} key={model.modelId}>
                      {plannerA?.provider_id} — {model.displayName} ({model.modelId})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Planner B
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
                Planner B model
                <select value={plannerBModel} onChange={(event) => setPlannerBModel(event.target.value)}>
                  {roleModels(plannerB, "planner").map((model) => (
                    <option value={model.modelId} key={model.modelId}>
                      {plannerB?.provider_id} — {model.displayName} ({model.modelId})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Canonical-plan synthesizer agent
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
                Synthesizer model
                <select value={synthesizerModel} onChange={(event) => setSynthesizerModel(event.target.value)}>
                  {roleModels(synthesizer, "synthesizer").map((model) => (
                    <option value={model.modelId} key={model.modelId}>
                      {synthesizer?.provider_id} — {model.displayName} ({model.modelId})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Approved implementation executor
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
                Approved executor model
                <select value={executorModel} onChange={(event) => setExecutorModel(event.target.value)}>
                  {roleModels(executor, "executor").map((model) => (
                    <option value={model.modelId} key={model.modelId}>
                      {executor?.provider_id} — {model.displayName} ({model.modelId})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Implementation reviewer agent <small>Recorded; automatic review remains disabled</small>
                <select
                  value={reviewerId}
                  onChange={(event) => {
                    const agent = reviewerAgents.find((item) => item.agent_id === event.target.value);
                    setReviewerId(event.target.value);
                    setReviewerModel(roleModels(agent, "implementation_reviewer")[0]?.modelId ?? "");
                  }}
                >
                  <option value="">No reviewer assignment</option>
                  {reviewerAgents.map((agent) => (
                    <option value={agent.agent_id} key={agent.agent_id}>
                      {agent.name} · {agent.provider_id}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Implementation reviewer model
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
                Maximum planning cost <small>Optional USD hard stop</small>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={maximumCost}
                  onChange={(event) => setMaximumCost(event.target.value)}
                />
              </label>
              <label>
                Maximum duration
                <select value={maximumDuration} onChange={(event) => setMaximumDuration(event.target.value)}>
                  <option value="1800">30 minutes</option>
                  <option value="3600">1 hour</option>
                  <option value="7200">2 hours</option>
                </select>
              </label>
            </>
          )}
          <ul>
            {missionType === "consensus" ? (
              <>
                <li>Exactly two distinct, capability-eligible planners</li>
                <li>One proposal, critique, and revision round</li>
                <li>Hash-bound verdicts and one exact bounded-action approval</li>
                <li>Separate governed implementation mission</li>
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
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button
            className="launch-button"
            disabled={
              !selected ||
              !objective.trim() ||
              pending ||
              (missionType === "consensus" &&
                (!acceptanceCriteria.trim() ||
                  !plannerAId ||
                  !plannerBId ||
                  plannerAId === plannerBId ||
                  !plannerAModel ||
                  !plannerBModel ||
                  !synthesizerId ||
                  !synthesizerModel ||
                  !executorId ||
                  !executorModel))
            }
            type="submit"
          >
            {pending
              ? "Creating durable assignment…"
              : missionType === "consensus"
                ? "Launch consensus plan"
                : missionType === "change"
                  ? "Launch change mission"
                  : "Launch analysis mission"}
            <span>→</span>
          </button>
        </form>
      </section>
    </main>
  );
}
