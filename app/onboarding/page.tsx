import { requirePageIdentity } from "@/lib/page-auth";
import { getDatabasePool } from "@/lib/database";
import OnboardingWizard from "./wizard";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const identity = await requirePageIdentity("/onboarding");
  const workspace = (
    await getDatabasePool().query(
      "SELECT name,onboarding_completed_at,onboarding_agent_type FROM workspaces WHERE id=$1",
      [identity.workspaceId],
    )
  ).rows[0];
  const agents = (
    await getDatabasePool().query(
      "SELECT agent_id,name,adapter_type,status,last_heartbeat_at,pull_ready_at,mission_agent_version,mission_agent_adapter FROM agents WHERE workspace_id=$1 ORDER BY created_at",
      [identity.workspaceId],
    )
  ).rows;
  return (
    <OnboardingWizard
      workspaceName={workspace.name}
      initialAgentType={workspace.onboarding_agent_type}
      agents={agents.map((agent) => ({
        ...agent,
        last_heartbeat_at: agent.last_heartbeat_at?.toISOString?.() ?? agent.last_heartbeat_at,
      }))}
    />
  );
}
