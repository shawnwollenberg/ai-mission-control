import Link from "next/link";
import { requirePageIdentity } from "@/lib/page-auth";
import { loadDashboardCards } from "@/v2/ui/dashboard-data";

export const dynamic = "force-dynamic";

export default async function V2Dashboard() {
  await requirePageIdentity("/v2");
  let cards: Awaited<ReturnType<typeof loadDashboardCards>> = [];
  let unavailable = "";
  try {
    cards = await loadDashboardCards();
  } catch (error) {
    unavailable = (error as Error).message;
  }
  const inbox = cards.filter((card) => card.state === "CTO_DECISION");
  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: "48px 24px", fontFamily: "system-ui" }}>
      <p style={{ fontFamily: "monospace", letterSpacing: 2 }}>MISSION CONTROL 2.0</p>
      <h1 style={{ fontSize: 48, margin: "8px 0" }}>Chief of Staff</h1>
      <p>Who has the ball, what they are doing, and where you are needed.</p>
      {unavailable ? (
        <p role="alert" style={{ padding: 16, background: "#eee" }}>
          V2 configuration unavailable: {unavailable}
        </p>
      ) : null}
      <section style={{ marginTop: 40 }}>
        <h2>
          CTO Inbox <span style={{ color: "#b00020" }}>{inbox.length}</span>
        </h2>
        {inbox.length ? (
          inbox.map((card) => <MissionRow key={card.missionId} card={card} />)
        ) : (
          <p>No owner decisions are waiting.</p>
        )}
      </section>
      <section style={{ marginTop: 40 }}>
        <h2>Active Mission Projects</h2>
        <div>
          {cards.map((card) => (
            <MissionRow key={card.missionId} card={card} />
          ))}
        </div>
      </section>
    </main>
  );
}

function MissionRow({ card }: { card: Awaited<ReturnType<typeof loadDashboardCards>>[number] }) {
  const colors = {
    BLUE: "#1769e0",
    ORANGE: "#d76600",
    RED: "#b00020",
    GRAY: "#6b7280",
    BLACK: "#171717",
    WHITE: "#fafafa",
  };
  return (
    <article
      style={{
        borderLeft: `8px solid ${colors[card.color]}`,
        borderBottom: "1px solid #ddd",
        padding: "18px 20px",
        background: card.color === "WHITE" ? "#fafafa" : "white",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 20, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0, flex: "1 1 360px" }}>
          <strong>{card.projectName}</strong> · {card.actor}
          <p style={{ margin: "7px 0" }}>{card.status}</p>
          {card.systemFailure ? <small>System/provider failure · Mission truth remains in GitHub</small> : null}
        </div>
        <div style={{ whiteSpace: "nowrap" }}>
          <Link href={`/v2/projects/${card.projectId}?issue=${card.issueNumber}`}>Open</Link> ·{" "}
          <a href={card.githubUrl}>GitHub</a>
        </div>
      </div>
    </article>
  );
}
