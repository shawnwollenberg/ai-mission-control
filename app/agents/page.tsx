import Link from "next/link";
import { requirePageIdentity } from "@/lib/page-auth";
import { listAgents } from "@/application/registry";
import AgentRegistry from "./registry";
export const dynamic = "force-dynamic";
export default async function AgentsPage() {
  const identity = await requirePageIdentity("/agents");
  return (
    <main className="durable-mission-shell">
      <nav className="brandbar">
        <div>
          <p className="eyebrow">Mission Control</p>
          <p className="brand-subtitle">Agent registry</p>
        </div>
        <Link className="nav-link" href="/missions">
          Missions
        </Link>
      </nav>
      <section className="principle">
        Your Mission Agent can now manage multiple repositories. Add another project with{" "}
        <code>mission-agent repository add</code>.
      </section>
      <AgentRegistry initialAgents={await listAgents(identity.workspaceId)} />
    </main>
  );
}
