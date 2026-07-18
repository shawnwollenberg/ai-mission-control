import { getDatabasePool } from "@/lib/database";
import type { ActionType } from "@/policy/policy-engine";
export async function loadPolicyRestrictions(
  workspaceId: string,
  input: { repositoryId?: string; agentId?: string; environment: string; actionType: ActionType },
) {
  const rows = (
    await getDatabasePool().query(
      `SELECT rules FROM policy_definitions WHERE workspace_id=$1 AND enabled AND effective_from<=now() AND (effective_until IS NULL OR effective_until>now()) AND (scope_type='workspace' OR (scope_type='repository' AND scope_id=$2) OR (scope_type='agent' AND scope_id=$3) OR (scope_type='environment' AND scope_id=$4) OR (scope_type='action' AND scope_id=$5)) ORDER BY priority`,
      [workspaceId, input.repositoryId ?? null, input.agentId ?? null, input.environment, input.actionType],
    )
  ).rows;
  return {
    deniedActions: Array.from(
      new Set<string>(
        rows.flatMap((row) => (Array.isArray(row.rules?.deniedActions) ? row.rules.deniedActions.map(String) : [])),
      ),
    ) as ActionType[],
  };
}
