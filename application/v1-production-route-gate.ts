import type { PoolClient } from "pg";

export const V1_PRODUCTION_ROUTES_FLAG = "MISSION_CONTROL_V1_PRODUCTION_ROUTES_ENABLED";

export function v1ProductionRoutesEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment[V1_PRODUCTION_ROUTES_FLAG] === "true";
}

export async function assertV1ProductionRouteContext(input: {
  client: PoolClient;
  workspaceId: string;
  credentialId: string;
  agentId: string;
  authorizationId: string;
  executionId: string;
  authorizationFingerprint: string;
  allowRecovery: boolean;
  allowControllerAdoption?: boolean;
}): Promise<void> {
  const result = await input.client.query<{
    rollout_state: string;
    configuration_state: string;
    configuration_checksum: string;
    deployment_configuration_checksum: string;
    attestation_expires_at: Date;
  }>(
    `SELECT r.state rollout_state,c.state configuration_state,c.configuration_checksum,
            controller.configuration_checksum deployment_configuration_checksum,
            controller.attestation_expires_at
       FROM mission_agent_v1_rollout_operations r
       JOIN mission_control_v1_production_configurations c
         ON c.configuration_id=r.configuration_id AND c.deployment_id=r.deployment_id
       JOIN mission_control_production_deployments controller
         ON controller.deployment_id=r.current_controller_deployment_id
       JOIN mission_agent_v1_operator_identities o
         ON o.workspace_id=r.workspace_id AND o.operator_id=r.operator_id
        AND o.agent_id=r.agent_id AND o.deployment_id=r.deployment_id
      WHERE r.workspace_id=$1 AND r.authorization_id=$2 AND r.execution_id=$3
        AND r.agent_id=$4 AND o.credential_id=$5 AND r.authorization_fingerprint=$6`,
    [
      input.workspaceId,
      input.authorizationId,
      input.executionId,
      input.agentId,
      input.credentialId,
      input.authorizationFingerprint,
    ],
  );
  const row = result.rows[0];
  const recoveryState = ["recovery_only", "human_intervention_required"].includes(row?.rollout_state ?? "");
  if (
    !row ||
    row.configuration_checksum !== row.deployment_configuration_checksum ||
    (!input.allowControllerAdoption && row.attestation_expires_at.getTime() <= Date.now()) ||
    !["read_only_preflight", "canary_authorized", "forward_active", "recovery_only"].includes(
      row.configuration_state,
    ) ||
    (!input.allowRecovery && recoveryState) ||
    (input.allowRecovery && !recoveryState && row.rollout_state === "expired_before_mutation")
  )
    throw new Error("V1 production route identity, configuration, or authorization is unavailable.");
}
