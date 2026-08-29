import Link from "next/link";
import { missionCardPresentation } from "./mission-card-presentation";
import type { MissionCard } from "./view-model";

export function MissionCardRow({ card }: { card: MissionCard }) {
  const presentation = missionCardPresentation(card.color);
  return (
    <article
      style={{
        borderLeft: `8px solid ${presentation.indicator}`,
        borderBottom: "1px solid #ddd",
        padding: "18px 20px",
        background: presentation.background,
        color: presentation.foreground,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 20, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0, flex: "1 1 360px" }}>
          <strong>{card.projectName}</strong> · {card.actor}
          <p style={{ margin: "7px 0" }}>{card.status}</p>
          {card.systemFailure ? <small>System/provider failure · Mission truth remains in GitHub</small> : null}
          {card.workerOffline ? (
            <small>Mission state is unchanged; work resumes when the worker reconnects.</small>
          ) : null}
        </div>
        <div style={{ whiteSpace: "nowrap" }}>
          <Link href={`/v2/projects/${card.projectId}?issue=${card.issueNumber}`} style={{ color: presentation.link }}>
            Open
          </Link>{" "}
          ·{" "}
          <a href={card.githubUrl} style={{ color: presentation.link }}>
            GitHub
          </a>
        </div>
      </div>
    </article>
  );
}
