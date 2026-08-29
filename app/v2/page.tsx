import { requirePageIdentity } from "@/lib/page-auth";
import { DashboardAutoRefresh } from "@/v2/ui/dashboard-auto-refresh";
import { loadDashboardData } from "@/v2/ui/dashboard-data";
import { MissionCardRow } from "@/v2/ui/mission-card-row";

export const dynamic = "force-dynamic";

export default async function V2Dashboard() {
  await requirePageIdentity("/v2");
  let cards: Awaited<ReturnType<typeof loadDashboardData>>["cards"] = [];
  let unavailable = "";
  let worker: Awaited<ReturnType<typeof loadDashboardData>>["worker"];
  try {
    ({ cards, worker } = await loadDashboardData());
  } catch (error) {
    unavailable = (error as Error).message;
  }
  const inbox = cards.filter((card) => card.state === "CTO_DECISION");
  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: "48px 24px", fontFamily: "system-ui" }}>
      <p style={{ fontFamily: "monospace", letterSpacing: 2 }}>MISSION CONTROL 2.0</p>
      <h1 style={{ fontSize: 48, margin: "8px 0" }}>Chief of Staff</h1>
      <p>Who has the ball, what they are doing, and where you are needed.</p>
      <DashboardAutoRefresh />
      <p style={{ color: worker?.status === "ONLINE" ? "#18733b" : "#6b7280", fontSize: 14 }}>
        Local Worker:{" "}
        {worker?.status === "ONLINE"
          ? "Online"
          : worker?.status === "AUTH_REQUIRED"
            ? "Codex sign-in required"
            : "Offline"}
        {worker ? ` · last contact ${new Date(worker.lastSeenAt).toLocaleString()}` : ""}
      </p>
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
          inbox.map((card) => <MissionCardRow key={card.missionId} card={card} />)
        ) : (
          <p>No owner decisions are waiting.</p>
        )}
      </section>
      <section style={{ marginTop: 40 }}>
        <h2>Active Mission Projects</h2>
        <div>
          {cards.map((card) => (
            <MissionCardRow key={card.missionId} card={card} />
          ))}
        </div>
      </section>
    </main>
  );
}
