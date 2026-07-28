export const V1_ROLLOUT_STATES = [
  "prepared",
  "preflight_verified",
  "drain_requested",
  "drained_verified",
  "forward_active",
  "grant_issued",
  "grant_delivered",
  "grant_acknowledged",
  "mutation_intent_committed",
  "awaiting_provider_receipt",
  "provider_receipt_accepted",
  "verifying",
  "observing",
  "recovery_only",
  "rollback_grant_issued",
  "rollback_grant_delivered",
  "rollback_grant_acknowledged",
  "rollback_intent_committed",
  "awaiting_rollback_receipt",
  "rollback_receipt_accepted",
  "rollback_verifying",
  "success_verified",
  "rollback_verified",
  "expired_before_mutation",
  "human_intervention_required",
] as const;
export type V1RolloutState = (typeof V1_ROLLOUT_STATES)[number];

export const V1_GRANT_STATES = [
  "proposed",
  "issued",
  "delivered",
  "acknowledged",
  "consumed",
  "expired_before_consumption",
  "revoked_before_consumption",
  "superseded",
  "failed_delivery",
] as const;
export type V1GrantState = (typeof V1_GRANT_STATES)[number];

export const V1_HANDLER_ACTIONS = {
  claim: ["preflight", "request_drain", "verify_drain", "acquire_lease", "renew_lease", "adopt_recovery_controller"],
  intent: ["propose_grant", "commit_mutation_intent"],
  status: [
    "record_grant_delivery",
    "acknowledge_grant",
    "operator_journal_head",
    "anchor_durable_receipt",
    "runtime_status",
    "rollback_observation",
  ],
  receipt: ["accept_provider_receipt"],
  decision: [
    "expire_grant",
    "revoke_grant",
    "verify_provider_receipt",
    "continue_forward",
    "continue_rollback",
    "observe_stability",
    "evaluate_stability",
    "close_success",
    "close_rollback",
  ],
  failure: ["activate_rollback", "require_human_intervention"],
} as const;

export type V1HandlerName = keyof typeof V1_HANDLER_ACTIONS;
export type V1HandlerAction = (typeof V1_HANDLER_ACTIONS)[V1HandlerName][number];

export const V1_FORWARD_MUTATION_ORDER = [
  "stage_artifact",
  "stop_agent",
  "install_agent",
  "install_launch_configuration",
  "start_agent",
] as const;

export const V1_ROLLBACK_MUTATION_ORDER = [
  "remove_staged_artifact",
  "stop_agent",
  "restore_previous_version",
  "restore_previous_launch_configuration",
  "install_launch_configuration",
  "start_agent",
] as const;

export type V1LifecycleBinding = {
  workspaceId: string;
  authorizationId: string;
  executionId: string;
  authorizationFingerprint: string;
  operatorId: string;
  hostFingerprint: string;
  operatorArtifactSha256: string;
  agentId: string;
  targetArtifactSha256: string;
  originatingForwardDeploymentId: string;
  currentControllerDeploymentId: string;
  configurationVersion: number;
  fencingGeneration: number;
  sequence: number;
  requestMessageId: string;
  requestNonce: string;
};

export function isV1HandlerAction(handler: V1HandlerName, action: string): boolean {
  return (V1_HANDLER_ACTIONS[handler] as readonly string[]).includes(action);
}
