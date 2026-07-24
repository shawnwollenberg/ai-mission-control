import { createHash } from "node:crypto";
import { canonicalJson } from "@/lib/canonical-json";
import type { ProjectBrainOperation } from "./types";

export type ProjectBrainOperationPolicy = {
  repositoryFilesChanged: boolean;
  requiresCleanWorktree: boolean;
  requiredPermission: "read" | "write";
  policyAction: string;
  approvalType?: string;
  allowedLocationModes: readonly ("server" | "mission_agent")[];
  artifactTypes: readonly string[];
  shaBehavior: "unchanged" | "content_write_same_head";
};

const read = (artifacts: string[] = []): ProjectBrainOperationPolicy => ({
  repositoryFilesChanged: false,
  requiresCleanWorktree: false,
  requiredPermission: "read",
  policyAction: "project_brain.read",
  allowedLocationModes: ["server", "mission_agent"],
  artifactTypes: artifacts,
  shaBehavior: "unchanged",
});
const write = (artifacts: string[]): ProjectBrainOperationPolicy => ({
  repositoryFilesChanged: true,
  requiresCleanWorktree: true,
  requiredPermission: "write",
  policyAction: "project_brain.repository_write",
  approvalType: "project_brain_repository_write",
  allowedLocationModes: ["server", "mission_agent"],
  artifactTypes: artifacts,
  shaBehavior: "content_write_same_head",
});

export const projectBrainOperationPolicies: Record<ProjectBrainOperation, ProjectBrainOperationPolicy> = {
  detect_repository: read(),
  validate_repository: read(),
  get_summary: read(),
  prepare_context: read(["project_brain_context_preview"]),
  read_context: read(["project_brain_context_pack"]),
  list_knowledge: read(),
  get_health: read(),
  diagnostics: read(),
  get_curation: read(),
  record_closure: write(["project_brain_closure"]),
  propose_learning: write(["project_brain_learning_proposal"]),
  evaluate_learning: write(["project_brain_evaluation"]),
};

export function projectBrainOperationPolicy(
  operation: ProjectBrainOperation,
  args: Record<string, unknown> = {},
): ProjectBrainOperationPolicy {
  if (operation === "prepare_context" && args.preview !== true) return write(["project_brain_context_pack"]);
  return projectBrainOperationPolicies[operation];
}

export function projectBrainRequestFingerprint(value: Record<string, unknown>) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function validateProjectBrainRequest(input: {
  operation: ProjectBrainOperation;
  repositoryId: string;
  locationMode: "server" | "mission_agent";
  startingSha?: string | null;
  timeoutMs: number;
  maxOutputBytes: number;
  arguments?: Record<string, unknown>;
}) {
  const policy = projectBrainOperationPolicy(input.operation, input.arguments);
  if (!policy) throw new Error("Project Brain operation is not allowlisted");
  if (!policy.allowedLocationModes.includes(input.locationMode))
    throw new Error("Project Brain operation is unsupported for this repository location");
  if (!input.repositoryId) throw new Error("Repository is required");
  if (input.timeoutMs < 1 || input.timeoutMs > 3_600_000) throw new Error("Invalid Project Brain timeout");
  if (input.maxOutputBytes < 1 || input.maxOutputBytes > 10_000_000)
    throw new Error("Invalid Project Brain output limit");
  if (policy.repositoryFilesChanged && !input.startingSha) throw new Error("Writing operation requires a starting SHA");
  return policy;
}
