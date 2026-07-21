"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BrandSprite } from "@/app/brand-assets";
import type { MissionReadModel } from "@/lib/mission-projection-store";
import type { MissionTimelineEntry } from "@/lib/mission-queries";
import type { ActionReadModel, ApprovalReadModel, ExecutionReadModel, TaskReadModel } from "@/lib/execution-queries";
import type { RecommendationReadModel } from "@/application/recommendation-queries";

const availableCommands: Record<string, Array<{ command: string; label: string }>> = {
  draft: [
    { command: "plan", label: "Plan mission" },
    { command: "cancel", label: "Cancel" },
  ],
  planned: [
    { command: "start", label: "Start execution" },
    { command: "cancel", label: "Cancel" },
  ],
  running: [
    { command: "pause", label: "Pause" },
    { command: "cancel", label: "Cancel" },
  ],
  paused: [
    { command: "resume", label: "Resume execution" },
    { command: "cancel", label: "Cancel" },
  ],
};
const hasMissionAgentCodex = (executions: ExecutionReadModel[]) =>
  executions.some(
    (execution) =>
      execution.adapterType === "remote_http" && execution.agentName?.toLocaleLowerCase().includes("codex"),
  );
const modeLabel = (mode: string, executions: ExecutionReadModel[]) =>
  hasMissionAgentCodex(executions)
    ? "Live Mission Agent · Codex"
    : mode === "live_codex"
      ? "Live Codex execution"
      : mode === "live_remote"
        ? "Live Hermes execution"
        : "Simulated execution";
const modeDescription = (mode: string, executions: ExecutionReadModel[]) =>
  hasMissionAgentCodex(executions)
    ? "Local Codex work is pulled over outbound HTTPS and durably supervised."
    : mode === "live_remote"
      ? "Authenticated remote work is durably delivered and supervised."
      : mode === "live_codex"
        ? "Connected work is isolated and supervised."
        : "No connected agent is running.";
const missionStatusSymbol = (status: string) => {
  if (status === "running") return <span className="status-symbol status-symbol-running" aria-hidden="true" />;
  if (status === "completed")
    return (
      <span className="status-symbol status-symbol-completed" aria-hidden="true">
        ✓
      </span>
    );
  if (status === "failed")
    return (
      <span className="status-symbol status-symbol-failed" aria-hidden="true">
        ×
      </span>
    );
  return null;
};

export default function DurableMissionConsole({
  initialMission,
  initialTimeline,
  initialTasks,
  initialApprovals,
  initialExecutions,
  initialActions,
  initialRecommendations,
}: {
  initialMission: MissionReadModel;
  initialTimeline: MissionTimelineEntry[];
  initialTasks: TaskReadModel[];
  initialApprovals: ApprovalReadModel[];
  initialExecutions: ExecutionReadModel[];
  initialActions: ActionReadModel[];
  initialRecommendations: RecommendationReadModel[];
}) {
  const [mission, setMission] = useState(initialMission);
  const [timeline, setTimeline] = useState(initialTimeline);
  const [tasks, setTasks] = useState(initialTasks);
  const [approvals, setApprovals] = useState(initialApprovals);
  const [executions, setExecutions] = useState(initialExecutions);
  const [actions, setActions] = useState(initialActions);
  const [recommendations, setRecommendations] = useState(initialRecommendations);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const timer = window.setInterval(async () => {
      const [executionResponse, timelineResponse] = await Promise.all([
        fetch(`/api/missions/${mission.missionId}/execution`, { cache: "no-store" }),
        fetch(`/api/missions/${mission.missionId}/events`, { cache: "no-store" }),
      ]);
      if (executionResponse.ok) {
        const body = (await executionResponse.json()) as {
          mission: MissionReadModel;
          tasks: TaskReadModel[];
          approvals: ApprovalReadModel[];
          executions: ExecutionReadModel[];
          actions: ActionReadModel[];
          recommendations: RecommendationReadModel[];
        };
        setMission(body.mission);
        setTasks(body.tasks);
        setApprovals(body.approvals);
        setExecutions(body.executions);
        setActions(body.actions);
        setRecommendations(body.recommendations);
      }
      if (timelineResponse.ok)
        setTimeline(((await timelineResponse.json()) as { timeline: MissionTimelineEntry[] }).timeline);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [mission.missionId, mission.status]);

  async function decide(approvalId: string, decision: "grant" | "deny") {
    setPending(true);
    const response = await fetch(`/api/approvals/${approvalId}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, reason: `${decision} recorded in Mission Control` }),
    });
    if (!response.ok) setError("Approval decision could not be recorded.");
    setPending(false);
  }
  async function cancelExecution(executionId: string) {
    setPending(true);
    const response = await fetch(`/api/executions/${executionId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: "{}",
    });
    if (!response.ok) setError("Execution cancellation could not be requested.");
    setPending(false);
  }
  async function publishForReview(executionId: string) {
    setPending(true);
    setError("");
    const response = await fetch(`/api/executions/${executionId}/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ actionType: "repository.publish_for_review", parameters: {}, targetResource: "derived" }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) setError(body.error?.message ?? "Publication approval could not be requested.");
    setPending(false);
  }

  async function command(name: string) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/missions/${mission.missionId}/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ expectedVersion: mission.aggregateVersion }),
      });
      const body = (await response.json()) as {
        projection?: MissionReadModel;
        error?: { code?: string; message?: string };
      };
      if (!response.ok || !body.projection) {
        if (body.error?.code === "concurrency_conflict") {
          setError("This mission changed in another process. Refreshing the durable state…");
          window.setTimeout(() => window.location.reload(), 900);
        } else setError(body.error?.message ?? "The command could not be applied.");
        return;
      }
      setMission(body.projection);
      const timelineResponse = await fetch(`/api/missions/${mission.missionId}/events`, { cache: "no-store" });
      if (timelineResponse.ok)
        setTimeline(((await timelineResponse.json()) as { timeline: MissionTimelineEntry[] }).timeline);
    } catch {
      setError("Mission Control could not reach the durable command service.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="durable-mission-shell">
      <nav className="brandbar">
        <BrandSprite asset="mark-compact" />
        <div>
          <p className="eyebrow">Mission Control</p>
          <p className="brand-subtitle">Durable mission command</p>
        </div>
        <Link className="nav-link" href="/missions">
          Mission archive
        </Link>
        <a className="nav-link" href="/logout">
          Log out
        </a>
      </nav>
      <header className="mission-header compact">
        <div>
          <p className="section-label">Mission / {mission.missionId.slice(0, 8)}</p>
          <h1>{mission.name}</h1>
          <p>{mission.objective}</p>
        </div>
        <div
          className={`status-pill status-${mission.status}`}
          role="status"
          aria-label={`Mission status: ${mission.status}`}
        >
          {missionStatusSymbol(mission.status)}
          <span>{mission.status}</span>
        </div>
      </header>
      <section className="execution-mode">
        <span>Execution mode</span>
        <strong>{modeLabel(mission.executionMode, executions)}</strong>
        <small>{modeDescription(mission.executionMode, executions)}</small>
      </section>
      <section className="durable-grid">
        <section className="command-panel mission-summary">
          <p className="section-label">Mission directive</p>
          <dl>
            <div>
              <dt>Domain</dt>
              <dd>{mission.domain.replaceAll("_", " ")}</dd>
            </div>
            <div>
              <dt>Priority</dt>
              <dd>{mission.priority}</dd>
            </div>
            <div>
              <dt>Risk</dt>
              <dd>{mission.riskLevel}</dd>
            </div>
            <div>
              <dt>Aggregate version</dt>
              <dd>{mission.aggregateVersion}</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{new Date(mission.createdAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd>{new Date(mission.updatedAt).toLocaleString()}</dd>
            </div>
          </dl>
          {mission.description && <p>{mission.description}</p>}
          {mission.successCriteria.length > 0 && (
            <div>
              <h3>Success criteria</h3>
              <ul>
                {mission.successCriteria.map((criterion) => (
                  <li key={criterion}>{criterion}</li>
                ))}
              </ul>
            </div>
          )}
          {mission.constraints.length > 0 && (
            <div>
              <h3>Constraints</h3>
              <ul>
                {mission.constraints.map((constraint) => (
                  <li key={constraint}>{constraint}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="mission-actions">
            {(availableCommands[mission.status] ?? []).map((item) => (
              <button disabled={pending} key={item.command} onClick={() => command(item.command)}>
                {item.label}
              </button>
            ))}
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </section>
        {executions.length > 0 && (
          <section className="command-panel mission-summary">
            <div className="panel-title">
              <div>
                <p className="section-label">Execution supervision</p>
                <h2>
                  {hasMissionAgentCodex(executions)
                    ? "Live Mission Agent · Codex"
                    : executions.some((e) => e.adapterType === "remote_http")
                      ? "Live Hermes execution"
                      : executions.some((e) => e.adapterType === "codex")
                        ? "Live Codex execution"
                        : "Simulated execution"}
                </h2>
              </div>
              <span>{executions.length} attempts</span>
            </div>
            {executions.map((execution) => (
              <div className="approval-card" key={execution.executionId}>
                <strong>
                  {execution.agentName ?? execution.agentId ?? "Agent"} · {execution.status}
                </strong>
                <p>
                  Execution {execution.executionId.slice(0, 8)} · attempt {execution.attempt} · stage{" "}
                  {execution.stage ?? "requested"}
                </p>
                <p>{execution.progressSummary ?? "Waiting for progress"}</p>
                <small>
                  Last heartbeat:{" "}
                  {execution.lastHeartbeat ? new Date(execution.lastHeartbeat).toLocaleString() : "Not received"} ·{" "}
                  {execution.commandsCompleted} commands · {execution.artifacts.length} artifacts
                </small>
                {execution.commitId && (
                  <>
                    <p>
                      Local commit: <code>{execution.commitId}</code>
                    </p>
                    {execution.status === "succeeded" &&
                      execution.artifacts.some((artifact) => artifact.kind === "git_patch") &&
                      !actions.some(
                        (action) =>
                          action.executionId === execution.executionId &&
                          action.actionType === "repository.publish_for_review",
                      ) && (
                        <div className="mission-actions">
                          <button disabled={pending} onClick={() => publishForReview(execution.executionId)}>
                            Publish for Review
                          </button>
                          <small>
                            Push this exact commit and open an evidence-rich pull request. Merge and deployment stay
                            disabled.
                          </small>
                        </div>
                      )}
                  </>
                )}
                {execution.failureClassification && <p>Failure: {execution.failureClassification}</p>}
                <ul>
                  {execution.artifacts.map((artifact) => (
                    <li key={artifact.artifactId}>
                      <Link href={`/artifacts/${artifact.artifactId}`}>
                        {artifact.kind} · {artifact.byteSize} bytes · {artifact.checksum.slice(0, 12)} →
                      </Link>
                    </li>
                  ))}
                </ul>
                {!["succeeded", "failed", "timed_out", "cancelled"].includes(execution.status) && (
                  <button
                    disabled={pending || Boolean(execution.cancellationRequestedAt)}
                    onClick={() => cancelExecution(execution.executionId)}
                  >
                    {execution.cancellationRequestedAt ? "Cancellation requested" : "Cancel execution"}
                  </button>
                )}
              </div>
            ))}
          </section>
        )}
        {actions.length > 0 && (
          <section className="command-panel mission-summary">
            <div className="panel-title">
              <div>
                <p className="section-label">Policy and publication</p>
                <h2>Sensitive actions</h2>
              </div>
              <Link href="/approvals">Approval inbox</Link>
            </div>
            {actions.map((action) => (
              <div className="approval-card" key={action.actionRequestId}>
                <strong>
                  {action.actionType === "repository.publish_for_review" ? "Publish for Review" : action.actionType} ·{" "}
                  {action.status === "waiting_for_approval"
                    ? "Publication Approval Required"
                    : action.status === "executing"
                      ? "Publishing"
                      : action.status === "succeeded"
                        ? "Pull Request Open"
                        : action.status === "failed"
                          ? "Publication Failed"
                          : action.status}
                </strong>
                <p>
                  Policy {action.policyVersion ?? "not evaluated"} · {action.policyOutcome ?? "pending"}
                </p>
                <ul>
                  {action.policyReasons.map((reason) => (
                    <li key={reason.code}>
                      {reason.message} <code>{reason.code}</code>
                    </li>
                  ))}
                </ul>
                {action.result && (
                  <p>
                    {action.actionType === "repository.publish_for_review"
                      ? `Provider-confirmed pull request: ${String((action.result.pullRequest as Record<string, unknown> | undefined)?.url ?? "pending")}`
                      : action.actionType === "repository.create_pull_request"
                        ? `Provider-confirmed pull request: ${String(action.result.url)}`
                        : `Remote branch: ${String(action.result.remoteRef)}`}
                  </p>
                )}
              </div>
            ))}
          </section>
        )}
        {recommendations.length > 0 && (
          <section className="command-panel mission-summary">
            <div className="panel-title">
              <div>
                <p className="section-label">Repository Health</p>
                <h2>Recommendations</h2>
              </div>
              <span>{recommendations.filter((r) => r.status === "open").length} open</span>
            </div>
            <div className="log-list">
              {recommendations.map((recommendation) => (
                <Link
                  className="log-item"
                  href={`/recommendations/${recommendation.recommendationId}`}
                  key={recommendation.recommendationId}
                >
                  <span className="log-sequence">{recommendation.estimatedImpact.slice(0, 2).toUpperCase()}</span>
                  <div>
                    <strong>{recommendation.title}</strong>
                    <small>
                      {recommendation.status} · {recommendation.estimatedRisk} risk · {recommendation.estimatedEffort}
                    </small>
                    <p>{recommendation.description}</p>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}
        <section className="command-panel mission-summary">
          <div className="panel-title">
            <div>
              <p className="section-label">Durable task plan</p>
              <h2>Dependency execution</h2>
            </div>
            <span>
              {mission.completedTaskCount}/{mission.totalTaskCount} complete
            </span>
          </div>
          <p>
            <strong>{modeLabel(mission.executionMode, executions)}</strong> · {mission.readyTaskCount} ready ·{" "}
            {mission.runningTaskCount} active · {mission.blockedTaskCount} blocked
          </p>
          <div className="log-list">
            {tasks.map((task) => (
              <div className="log-item" key={task.taskId}>
                <span className="log-sequence">{task.status.slice(0, 2).toUpperCase()}</span>
                <div>
                  <strong>{task.name}</strong>
                  <small>
                    {executions.find((execution) => execution.taskId === task.taskId)?.agentName ??
                      task.assignedExecutor ??
                      "Unassigned"}{" "}
                    · attempt {task.currentAttempt}/{task.maximumAttempts} · {task.riskLevel} risk
                  </small>
                  {task.progressSummary && <p>{task.progressSummary}</p>}
                  {task.blockingDependencies.length > 0 && (
                    <p>
                      Blocked by{" "}
                      {task.blockingDependencies
                        .map((id) => tasks.find((t) => t.taskId === id)?.name ?? id.slice(0, 8))
                        .join(", ")}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
          {approvals.map((approval) => (
            <div className="approval-card" key={approval.approvalId}>
              <strong>{approval.status === "pending" ? "Approval required" : `Approval ${approval.status}`}</strong>
              <p>{approval.riskExplanation}</p>
              {approval.status === "pending" && (
                <div className="mission-actions">
                  <button disabled={pending} onClick={() => decide(approval.approvalId, "grant")}>
                    {actions.some(
                      (action) =>
                        action.approvalId === approval.approvalId &&
                        action.actionType === "repository.publish_for_review",
                    )
                      ? "Publish for Review"
                      : "Grant and continue"}
                  </button>
                  <button disabled={pending} onClick={() => decide(approval.approvalId, "deny")}>
                    Deny
                  </button>
                </div>
              )}
            </div>
          ))}
          {["completed", "failed", "cancelled"].includes(mission.status) && (
            <div>
              <h3>Durable debrief</h3>
              <p>
                {mission.name} finished with status <strong>{mission.status}</strong>. {mission.completedTaskCount}{" "}
                tasks completed, {mission.failedTaskCount} failed, and {mission.cancelledTaskCount} were cancelled.{" "}
                {timeline.length} canonical events,{" "}
                {approvals.filter((approval) => approval.status !== "pending").length} approval decisions, and{" "}
                {executions.reduce((count, execution) => count + execution.artifacts.length, 0)} artifacts were recorded
                over{" "}
                {Math.max(
                  0,
                  Math.round((new Date(mission.updatedAt).getTime() - new Date(mission.createdAt).getTime()) / 1000),
                )}{" "}
                seconds. The recorded {modeLabel(mission.executionMode, executions).toLowerCase()} outcome is{" "}
                {mission.status}.
                {actions.some(
                  (action) =>
                    ["repository.push_branch", "repository.publish_for_review"].includes(action.actionType) &&
                    action.status === "succeeded",
                )
                  ? " The exact approved branch was pushed."
                  : " No branch push was recorded."}{" "}
                {actions.some(
                  (action) =>
                    ["repository.create_pull_request", "repository.publish_for_review"].includes(action.actionType) &&
                    action.status === "succeeded",
                )
                  ? " A provider-confirmed pull request was created."
                  : " No pull request was created."}{" "}
                No merge or deployment was performed.
              </p>
            </div>
          )}
        </section>
        <section className="command-panel mission-log">
          <div className="panel-title">
            <div>
              <p className="section-label">Mission timeline</p>
              <h2>Canonical history</h2>
            </div>
            <span>{timeline.length} events</span>
          </div>
          <div className="log-list">
            {[...timeline].reverse().map((entry) => (
              <div className="log-item log-milestone" key={entry.eventId}>
                <span className="log-sequence">{String(entry.sequence).padStart(2, "0")}</span>
                <div>
                  <strong>{entry.label}</strong>
                  <small>
                    {entry.actor} · {new Date(entry.timestamp).toLocaleString()}
                  </small>
                  <p>{entry.summary}</p>
                  {entry.imported && <em>Imported legacy event</em>}
                </div>
              </div>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}
