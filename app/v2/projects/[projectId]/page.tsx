import { requirePageIdentity } from "@/lib/page-auth";
import { createV2MissionRuntime } from "@/v2/runtime/service";
import { DecisionForm } from "./decision-form";
import { ReconciliationForm } from "./reconciliation-form";
import { AmendmentForm } from "./amendment-form";
import { PostgresWorkerCoordinationStore } from "@/v2/worker/store";

export const dynamic = "force-dynamic";
export default async function ProjectDetail({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ issue?: string }>;
}) {
  const { projectId } = await params;
  await requirePageIdentity(`/v2/projects/${projectId}`);
  const issueNumber = Number((await searchParams).issue);
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1)
    throw new Error("A positive mission issue number is required");
  const runtime = await createV2MissionRuntime(projectId);
  const state = await runtime.store.readMission({ issueNumber });
  const issue = await runtime.api.readIssue(issueNumber);
  const dispatches = (await new PostgresWorkerCoordinationStore().list()).filter(
    (item) => item.dispatch.missionId === state.mission.missionId,
  );
  const latestDispatch = dispatches.at(-1);
  return (
    <main
      style={{
        width: "100%",
        maxWidth: 900,
        margin: "0 auto",
        padding: "48px 24px",
        boxSizing: "border-box",
        overflowWrap: "anywhere",
        fontFamily: "system-ui",
      }}
    >
      <a href="/v2">← Dashboard</a>
      <p style={{ fontFamily: "monospace" }}>{runtime.project.name}</p>
      <h1 style={{ fontSize: "clamp(28px, 7vw, 42px)" }}>{state.mission.objective}</h1>
      <p>
        <strong>{state.mission.currentActor}</strong> · {state.mission.state} · revision {state.latestRevision}
      </p>
      {latestDispatch?.failureCode ? (
        <section role="alert" style={{ border: "2px solid #6b7280", padding: 20 }}>
          <h2>System/provider failure</h2>
          <p>{latestDispatch.failureCode}</p>
          <p>Mission truth remains in GitHub. No authority was implicitly granted and no unsafe retry occurs.</p>
        </section>
      ) : null}
      {state.latestEngineerReport ? (
        <section>
          <h2>Latest Engineer report</h2>
          <p>{state.latestEngineerReport.summary}</p>
        </section>
      ) : null}
      {state.latestArchitectDecision ? (
        <section>
          <h2>Latest Architect decision</h2>
          <p>
            {state.latestArchitectDecision.decision}: {state.latestArchitectDecision.rationale}
          </p>
        </section>
      ) : null}
      {state.pendingCtoRequest ? (
        <section style={{ border: "2px solid #b00020", padding: 20 }}>
          <h2>CTO decision required</h2>
          <p>
            <strong>{state.pendingCtoRequest.capability}</strong> · {state.pendingCtoRequest.action}
          </p>
          <dl>
            <dt>Financial effect</dt>
            <dd>{state.pendingCtoRequest.financialEffect}</dd>
            <dt>External/on-chain effect</dt>
            <dd>{state.pendingCtoRequest.externalEffect}</dd>
            <dt>Reversible</dt>
            <dd>{state.pendingCtoRequest.reversible ? "Yes" : "No"}</dd>
            <dt>Architect recommendation</dt>
            <dd>{state.pendingCtoRequest.architectRecommendation}</dd>
            <dt>Age</dt>
            <dd>{formatAge(issue.comments.at(-1)?.createdAt ?? issue.updatedAt)}</dd>
          </dl>
          <DecisionForm
            projectId={projectId}
            issueNumber={issueNumber}
            requestRevision={state.pendingCtoRequest.revision}
          />
        </section>
      ) : null}
      {state.mission.state === "BLOCKED_EXTERNAL" ? (
        <section style={{ border: "2px solid #6b7280", padding: 20 }}>
          <h2>Owner reconciliation</h2>
          <p>
            Reopen only when new evidence materially changes the external block. This appends canonical Mission truth
            and routes a fresh Architect reassessment.
          </p>
          <ReconciliationForm projectId={projectId} issueNumber={issueNumber} blockedRevision={state.latestRevision} />
          <hr />
          <h3>Amend obsolete acceptance criteria</h3>
          <p>
            This preserves the prior criteria in canonical history and replaces only the complete acceptance-criteria
            list at the exact blocked revision. Objective, constraints, and authority do not change.
          </p>
          <AmendmentForm
            projectId={projectId}
            issueNumber={issueNumber}
            blockedRevision={state.latestRevision}
            acceptanceCriteria={state.mission.acceptanceCriteria}
          />
        </section>
      ) : null}
      <section>
        <h2>Recent transitions</h2>
        <ol>
          {state.recentTransitions.map((transition) => (
            <li key={transition.revision}>
              Revision {transition.revision}: {transition.schema}
            </li>
          ))}
        </ol>
      </section>
      <section>
        <h2>Contexts</h2>
        <p>
          <a href={issue.url}>GitHub Mission</a> · <a href={runtime.project.repositoryUrl}>Repository</a>
          {latestDispatch?.providerThreadId ? (
            <>
              {" "}
              · Provider thread <code>{latestDispatch.providerThreadId}</code>
            </>
          ) : null}
        </p>
      </section>
    </main>
  );
}

function formatAge(value: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}
