import type { ProjectBrainEnvelope } from "./types";

export function ProjectBrainPanel(props: {
  status?: ProjectBrainEnvelope<Record<string, unknown>>;
  summary?: ProjectBrainEnvelope<Record<string, unknown>>;
  health?: ProjectBrainEnvelope<Record<string, unknown>>;
  inbox?: { proposals: unknown[]; evaluations: unknown[]; promotionAvailable: false };
  projectedStatus?: string;
  context?: ProjectBrainEnvelope<Record<string, unknown>>;
  projection?: Record<string, unknown>;
  error?: string;
}) {
  return (
    <section className="command-panel" aria-label="Project Brain">
      <div className="panel-heading">
        <div>
          <p className="section-label">Repository knowledge</p>
          <h2>Project Brain</h2>
        </div>
        <span>{props.projectedStatus ?? props.status?.status ?? "not connected"}</span>
      </div>
      {props.error ? <p role="alert">{props.error}</p> : null}
      {props.projection ? <pre>{JSON.stringify(props.projection, null, 2)}</pre> : null}
      {props.summary ? <pre>{JSON.stringify(props.summary.data, null, 2)}</pre> : <p>No summary loaded.</p>}
      {props.health ? (
        <div>
          <h3>Knowledge health</h3>
          <pre>{JSON.stringify(props.health.data, null, 2)}</pre>
        </div>
      ) : null}
      {props.context ? (
        <div>
          <h3>Context evidence</h3>
          <pre>{JSON.stringify(props.context.data, null, 2)}</pre>
          <small>Completeness and precision are separate indicators. No optimality claim is made.</small>
        </div>
      ) : null}
      {props.inbox ? (
        <div>
          <h3>Learning approval inbox (read only)</h3>
          <p>
            {props.inbox.proposals.length} proposals · {props.inbox.evaluations.length} evaluator reports
          </p>
          <pre>{JSON.stringify(props.inbox, null, 2)}</pre>
        </div>
      ) : null}
      <p>Promotion remains a human-gated Project Brain repository workflow and is unavailable in this UI.</p>
    </section>
  );
}
