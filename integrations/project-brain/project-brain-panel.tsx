import type { ProjectBrainEnvelope } from "./types";

export function ProjectBrainPanel(props: {
  status?: ProjectBrainEnvelope<Record<string, unknown>>;
  summary?: ProjectBrainEnvelope<Record<string, unknown>>;
  context?: ProjectBrainEnvelope<Record<string, unknown>>;
  error?: string;
}) {
  return (
    <section className="command-panel" aria-label="Project Brain">
      <div className="panel-heading">
        <div>
          <p className="section-label">Repository knowledge</p>
          <h2>Project Brain</h2>
        </div>
        <span>{props.status?.status ?? "not connected"}</span>
      </div>
      {props.error ? <p role="alert">{props.error}</p> : null}
      {props.summary ? <pre>{JSON.stringify(props.summary.data, null, 2)}</pre> : <p>No summary loaded.</p>}
      {props.context ? (
        <div>
          <h3>Context evidence</h3>
          <pre>{JSON.stringify(props.context.data, null, 2)}</pre>
          <small>Completeness and precision are separate indicators. No optimality claim is made.</small>
        </div>
      ) : null}
      <p>
        Learning proposals and evaluation results are read-only here. Promotion remains a human-gated Project
        Brain action.
      </p>
    </section>
  );
}
