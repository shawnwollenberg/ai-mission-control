export const REMOTE_APPROVAL_POLICY_VERSION = "phase4.remote.1";
const allowed = new Set([
  "analysis.continue",
  "task.activate_codex",
  "execution.extend_timeout",
  "resource.request_readonly",
  "mission.accept_reorganization",
  "repository.modify",
]);
const prohibited = new Set([
  "transaction.sign",
  "transaction.submit",
  "funds.transfer",
  "position.modify",
  "wallet.permission.modify",
  "policy.modify",
  "production.remediate",
  "secret.access",
  "repository.merge",
  "deployment.start",
  "infrastructure.modify",
]);
export function evaluateRemoteApproval(actionType: string) {
  if (prohibited.has(actionType))
    return {
      outcome: "deny" as const,
      policyVersion: REMOTE_APPROVAL_POLICY_VERSION,
      reasons: [
        { code: "action.permanently_denied", message: "The requested remote action is permanently prohibited." },
      ],
    };
  if (!allowed.has(actionType))
    return {
      outcome: "deny" as const,
      policyVersion: REMOTE_APPROVAL_POLICY_VERSION,
      reasons: [{ code: "action.unsupported", message: "The requested remote workflow action is not supported." }],
    };
  return {
    outcome: "require_approval" as const,
    policyVersion: REMOTE_APPROVAL_POLICY_VERSION,
    reasons: [
      { code: "human.workflow_boundary", message: "Owner approval is required before changing mission workflow." },
    ],
  };
}
