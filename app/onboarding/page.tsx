import { requirePageIdentity } from "@/lib/page-auth";
import { getDatabasePool } from "@/lib/database";
import OnboardingWizard from "./wizard";

export const dynamic = "force-dynamic";

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ agent?: string }> }) {
  const identity = await requirePageIdentity("/onboarding");
  const workspace = (
    await getDatabasePool().query(
      "SELECT name,onboarding_completed_at,onboarding_agent_type FROM workspaces WHERE id=$1",
      [identity.workspaceId],
    )
  ).rows[0];
  const agents = (
    await getDatabasePool().query(
      `SELECT a.agent_id,a.name,a.adapter_type,a.status,
        CASE WHEN a.last_heartbeat_at>now()-interval '5 minutes' THEN a.last_heartbeat_at END last_heartbeat_at,
        CASE WHEN a.pull_ready_at>now()-interval '5 minutes' THEN a.pull_ready_at END pull_ready_at,
        a.mission_agent_version,a.mission_agent_adapter,
        (SELECT count(*)::int FROM repositories r WHERE r.workspace_id=a.workspace_id AND r.allowed_agent_ids ? a.agent_id::text AND r.disabled_at IS NULL) repository_count
       FROM agents a WHERE a.workspace_id=$1 ORDER BY a.created_at`,
      [identity.workspaceId],
    )
  ).rows;
  return (
    <OnboardingWizard
      workspaceName={workspace.name}
      initialAgentType={
        ((await searchParams).agent ?? workspace.onboarding_agent_type) as
          "codex" | "hermes" | "claude_code" | "generic_remote" | undefined
      }
      agents={agents.map((agent) => ({
        ...agent,
        last_heartbeat_at: agent.last_heartbeat_at?.toISOString?.() ?? agent.last_heartbeat_at,
      }))}
    />
  );
}
