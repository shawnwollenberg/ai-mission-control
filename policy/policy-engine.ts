export const POLICY_VERSION = "phase3.1";

export const actionTypes = [
  "repository.push_branch",
  "repository.create_pull_request",
  "repository.merge_pull_request",
  "deployment.start",
  "database.run_migration",
  "database.run_destructive_command",
  "infrastructure.modify",
  "secret.read",
  "secret.modify",
  "execution.expand_permissions",
  "execution.extend_timeout",
  "execution.increase_budget",
] as const;
export type ActionType = (typeof actionTypes)[number];
export type PolicyReason = { code: string; message: string };
export type PolicyDecision =
  | { outcome: "allow"; policyVersion: string; reasons: PolicyReason[] }
  | {
      outcome: "require_approval";
      policyVersion: string;
      approvalType: string;
      reasons: PolicyReason[];
      expiresAt?: string;
    }
  | { outcome: "deny"; policyVersion: string; reasons: PolicyReason[] };

export type PolicyInput = {
  actionType: ActionType;
  environment: string;
  agent: { status: string; trustLevel: string; capabilities: string[] };
  repository?: {
    defaultBranch: string;
    protectedBranches: string[];
    allowedBranchPrefixes: string[];
    allowedRemotes: string[];
    pushAllowed: boolean;
    pullRequestAllowed: boolean;
  };
  parameters: Record<string, unknown>;
  reversible: boolean;
  affectsExternalSystem: boolean;
  restrictions?: { deniedActions?: ActionType[] };
};

const reason = (code: string, message: string): PolicyReason => ({ code, message });
const permanentlyDenied = new Set<ActionType>([
  "repository.merge_pull_request",
  "deployment.start",
  "database.run_destructive_command",
  "infrastructure.modify",
  "secret.read",
  "secret.modify",
]);

export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  if (input.agent.status !== "active")
    return {
      outcome: "deny",
      policyVersion: POLICY_VERSION,
      reasons: [reason("agent.unavailable", "The agent is not active.")],
    };
  if (permanentlyDenied.has(input.actionType))
    return {
      outcome: "deny",
      policyVersion: POLICY_VERSION,
      reasons: [reason("action.permanently_denied", "This action is prohibited by the Phase 3 safety boundary.")],
    };
  if (input.restrictions?.deniedActions?.includes(input.actionType))
    return {
      outcome: "deny",
      policyVersion: POLICY_VERSION,
      reasons: [reason("scope.restriction", "A scoped policy explicitly denies this action.")],
    };
  if (input.actionType === "repository.push_branch") {
    const repository = input.repository;
    const branch = String(input.parameters.branch ?? "");
    const remote = String(input.parameters.remote ?? "");
    const force = input.parameters.force === true;
    if (!repository?.pushAllowed)
      return {
        outcome: "deny",
        policyVersion: POLICY_VERSION,
        reasons: [reason("repository.push_disabled", "Repository push capability is disabled.")],
      };
    if (force)
      return {
        outcome: "deny",
        policyVersion: POLICY_VERSION,
        reasons: [reason("git.force_push", "Force push is prohibited.")],
      };
    if (branch === repository.defaultBranch || repository.protectedBranches.includes(branch))
      return {
        outcome: "deny",
        policyVersion: POLICY_VERSION,
        reasons: [reason("git.protected_branch", "Direct push to a protected branch is prohibited.")],
      };
    if (!repository.allowedBranchPrefixes.some((prefix) => branch.startsWith(prefix)))
      return {
        outcome: "deny",
        policyVersion: POLICY_VERSION,
        reasons: [reason("git.branch_prefix", "The branch is outside the generated branch allowlist.")],
      };
    if (!repository.allowedRemotes.includes(remote))
      return {
        outcome: "deny",
        policyVersion: POLICY_VERSION,
        reasons: [reason("git.remote", "The remote is not approved for this repository.")],
      };
    return {
      outcome: "require_approval",
      policyVersion: POLICY_VERSION,
      approvalType: "repository_push",
      reasons: [
        reason(
          "external.code_publication",
          "Approval required because this action publishes code to an external repository.",
        ),
      ],
    };
  }
  if (input.actionType === "repository.create_pull_request") {
    if (!input.repository?.pullRequestAllowed)
      return {
        outcome: "deny",
        policyVersion: POLICY_VERSION,
        reasons: [reason("repository.pull_request_disabled", "Pull-request creation is disabled.")],
      };
    if (String(input.parameters.targetBranch ?? "") !== input.repository.defaultBranch)
      return {
        outcome: "deny",
        policyVersion: POLICY_VERSION,
        reasons: [reason("git.invalid_target", "Pull requests must target the configured default branch.")],
      };
    return {
      outcome: "require_approval",
      policyVersion: POLICY_VERSION,
      approvalType: "pull_request_create",
      reasons: [reason("external.pull_request", "Approval required before creating a pull request with the provider.")],
    };
  }
  return {
    outcome: "require_approval",
    policyVersion: POLICY_VERSION,
    approvalType: "sensitive_action",
    reasons: [reason("action.sensitive", "This sensitive action requires explicit owner approval.")],
  };
}
