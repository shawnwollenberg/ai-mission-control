import { requirePageIdentity } from "@/lib/page-auth";
import { createV2MissionRuntime } from "@/v2/runtime/service";
import { DecisionForm } from "./decision-form";

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
  const binding = await runtime.bindings.get(state.mission.missionId);
  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: "48px 24px", fontFamily: "system-ui" }}>
      <a href="/v2">← Dashboard</a>
      <p style={{ fontFamily: "monospace" }}>{runtime.project.name}</p>
      <h1>{state.mission.objective}</h1>
      <p>
        <strong>{state.mission.currentActor}</strong> · {state.mission.state} · revision {state.latestRevision}
      </p>
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
          <DecisionForm
            projectId={projectId}
            issueNumber={issueNumber}
            requestRevision={state.pendingCtoRequest.revision}
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
          {binding?.codexThreadId ? (
            <>
              {" "}
              · Codex thread <code>{binding.codexThreadId}</code>
            </>
          ) : null}
          {binding?.architectResponseId ? (
            <>
              {" "}
              · Architect response <code>{binding.architectResponseId}</code>
            </>
          ) : null}
        </p>
      </section>
    </main>
  );
}
