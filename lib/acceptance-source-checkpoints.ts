import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { canonicalJson } from "@/lib/canonical-json";
import type { DisposableAcceptanceArtifact } from "@/lib/runtime-trust";

export const ACCEPTANCE_SOURCE_CLOSURE_FAILURE = "ACCEPTANCE SOURCE CLOSURE FAILURE";
export const acceptanceSourceCheckpoints = [
  "before_mission_creation",
  "before_human_approval",
  "before_child_creation",
  "before_executor_claim",
] as const;
export type AcceptanceSourceCheckpoint = (typeof acceptanceSourceCheckpoints)[number];
export const finalAcceptanceSourceCheckpoints = [
  "before_independent_review",
  "before_final_cleanup",
  "after_final_cleanup",
] as const;
export type FinalAcceptanceSourceCheckpoint = (typeof finalAcceptanceSourceCheckpoints)[number];
export type AnyAcceptanceSourceCheckpoint = AcceptanceSourceCheckpoint | FinalAcceptanceSourceCheckpoint;

type SourceManifest = {
  schemaVersion: "mission-control-acceptance-source-manifest/1";
  scope: "disposable_consensus_acceptance_security_boundary";
  sourceBase: string;
  includedRoots: string[];
  includedFiles: string[];
  excludedFiles: string[];
  files: Record<string, string>;
};

export type AcceptanceSourceRevalidationEvidence = {
  schema_version: "acceptance-source-revalidation/1";
  checkpoint: AnyAcceptanceSourceCheckpoint;
  acceptance_run_id: string;
  checkpoint_id: string;
  action_binding: Record<string, string>;
  authority_binding: Record<string, string>;
  manifest_sha256: string;
  manifest_canonical_sha256: string;
  governed_file_count: number;
  validated_at: string;
  result: "pass" | "fail";
  missing_files: string[];
  unexpected_files: string[];
  changed_files: string[];
  invalid_file_types: string[];
  binding_hash: string;
};

const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SAFE_PATH = /^[a-zA-Z0-9][a-zA-Z0-9._/\[\]-]*$/;
const sha256 = (value: string | Buffer) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : Uint8Array.from(value))
    .digest("hex");
const isWithin = (root: string, candidate: string) => {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};
const validPath = (path: string) => SAFE_PATH.test(path) && !path.split("/").includes("..") && !isAbsolute(path);
const bounded = (paths: Iterable<string>) => Array.from(new Set(paths)).sort().slice(0, 256);
const checkpointActionBindings: Record<AcceptanceSourceCheckpoint, { action: string; keys: string[] }> = {
  before_mission_creation: {
    action: "create_consensus_mission",
    keys: ["action", "command_id", "mission_id", "repository_id"],
  },
  before_human_approval: {
    action: "submit_human_approval",
    keys: ["action", "approval_id", "canonical_plan_hash", "mission_id"],
  },
  before_child_creation: {
    action: "create_child_implementation_mission",
    keys: ["action", "canonical_plan_hash", "child_mission_id", "command_id", "parent_mission_id"],
  },
  before_executor_claim: {
    action: "authorize_executor_claim",
    keys: ["action", "assignment_id", "child_mission_id", "execution_id", "executor_agent_id", "parent_mission_id"],
  },
};
function validateActionBinding(checkpoint: AcceptanceSourceCheckpoint, binding: Record<string, string>) {
  const expected = checkpointActionBindings[checkpoint];
  if (
    Object.keys(binding).sort().join("\n") !== expected.keys.sort().join("\n") ||
    binding.action !== expected.action ||
    Object.entries(binding).some(([key, value]) => {
      if (!value) return true;
      if (key === "action") return false;
      if (key === "canonical_plan_hash") return !SHA256.test(value);
      return !UUID.test(value);
    })
  )
    throw new Error(`${ACCEPTANCE_SOURCE_CLOSURE_FAILURE}: protected action binding is invalid for ${checkpoint}`);
}

export class AcceptanceSourceClosureFailure extends Error {
  readonly reasonCode = "ACCEPTANCE_SOURCE_CLOSURE_FAILURE" as const;
  constructor(readonly evidence: AcceptanceSourceRevalidationEvidence) {
    super(`${ACCEPTANCE_SOURCE_CLOSURE_FAILURE}: ${evidence.checkpoint}`);
    this.name = "AcceptanceSourceClosureFailure";
  }
}

export class AcceptanceSourceCheckpointRejection extends Error {
  readonly reasonCode = "SOURCE_CHECKPOINT_REUSE_REJECTED" as const;
  constructor(readonly misuse: string) {
    super(`${ACCEPTANCE_SOURCE_CLOSURE_FAILURE}: checkpoint evidence binding rejected`);
    this.name = "AcceptanceSourceCheckpointRejection";
  }
}

export function loadApprovedAcceptanceSource(artifact: DisposableAcceptanceArtifact, repositoryRoot = process.cwd()) {
  const root = realpathSync(repositoryRoot);
  const manifestPath = resolve(root, "domain/mission-control-acceptance-source-manifest.json");
  const schemaPath = resolve(root, "domain/mission-control-acceptance-source-manifest.schema.json");
  const manifestBytes = readFileSync(manifestPath);
  const schemaBytes = readFileSync(schemaPath);
  if (sha256(manifestBytes) !== artifact.acceptanceSourceManifestSha256)
    throw new Error("Mission Control acceptance source manifest file hash changed");
  if (sha256(schemaBytes) !== artifact.acceptanceSourceManifestSchemaSha256)
    throw new Error("Mission Control acceptance source manifest schema hash changed");
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as SourceManifest;
  if (
    manifest.schemaVersion !== "mission-control-acceptance-source-manifest/1" ||
    manifest.scope !== "disposable_consensus_acceptance_security_boundary" ||
    manifest.sourceBase !== artifact.sourceCommit ||
    !Array.isArray(manifest.includedRoots) ||
    !Array.isArray(manifest.includedFiles) ||
    !Array.isArray(manifest.excludedFiles) ||
    !manifest.files ||
    Object.keys(manifest.files).length === 0 ||
    [
      ...manifest.includedRoots,
      ...manifest.includedFiles,
      ...manifest.excludedFiles,
      ...Object.keys(manifest.files),
    ].some((path) => typeof path !== "string" || !validPath(path)) ||
    Object.values(manifest.files).some((hash) => !SHA256.test(hash)) ||
    sha256(canonicalJson(manifest)) !== artifact.acceptanceSourceManifestCanonicalSha256
  )
    throw new Error("Mission Control acceptance source manifest authority is invalid");
  return { root, manifestPath, manifest, artifact };
}

function inspectFreshSource(
  approved: ReturnType<typeof loadApprovedAcceptanceSource>,
  checkpoint: AnyAcceptanceSourceCheckpoint,
  acceptanceRunId: string,
  actionBinding: Record<string, string>,
  authorityBinding: Record<string, string>,
): AcceptanceSourceRevalidationEvidence {
  const missing: string[] = [];
  const unexpected: string[] = [];
  const changed: string[] = [];
  const invalidTypes: string[] = [];
  let manifestBytes = Buffer.alloc(0);
  let manifestCanonicalSha256 = "0".repeat(64);
  try {
    const info = lstatSync(approved.manifestPath);
    if (!info.isFile() || info.isSymbolicLink()) invalidTypes.push(relative(approved.root, approved.manifestPath));
    manifestBytes = readFileSync(approved.manifestPath);
    try {
      manifestCanonicalSha256 = sha256(canonicalJson(JSON.parse(manifestBytes.toString("utf8"))));
    } catch {
      changed.push(relative(approved.root, approved.manifestPath));
    }
  } catch {
    missing.push(relative(approved.root, approved.manifestPath));
  }
  if (sha256(manifestBytes) !== approved.artifact.acceptanceSourceManifestSha256)
    changed.push(relative(approved.root, approved.manifestPath));

  const discovered = new Set<string>();
  const excluded = new Set(approved.manifest.excludedFiles);
  const discover = (relativePath: string) => {
    const candidate = resolve(approved.root, relativePath);
    let info;
    try {
      info = lstatSync(candidate);
    } catch {
      missing.push(relativePath);
      return;
    }
    if (info.isSymbolicLink()) {
      invalidTypes.push(relativePath);
      return;
    }
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch {
      invalidTypes.push(relativePath);
      return;
    }
    if (!isWithin(approved.root, real)) {
      invalidTypes.push(relativePath);
      return;
    }
    if (info.isDirectory()) {
      let entries: string[];
      try {
        entries = readdirSync(candidate).sort();
      } catch {
        invalidTypes.push(relativePath);
        return;
      }
      for (const entry of entries) discover(`${relativePath}/${entry}`);
      return;
    }
    if (!info.isFile()) {
      invalidTypes.push(relativePath);
      return;
    }
    if (!excluded.has(relativePath)) discovered.add(relativePath);
  };
  for (const path of approved.manifest.includedRoots) discover(path);
  for (const path of approved.manifest.includedFiles) discover(path);
  const declared = new Set(Object.keys(approved.manifest.files));
  for (const path of Array.from(declared)) if (!discovered.has(path)) missing.push(path);
  for (const path of Array.from(discovered)) if (!declared.has(path)) unexpected.push(path);
  for (const [path, expected] of Object.entries(approved.manifest.files)) {
    const candidate = resolve(approved.root, path);
    try {
      const info = lstatSync(candidate);
      if (!info.isFile() || info.isSymbolicLink() || !isWithin(approved.root, realpathSync(candidate))) {
        invalidTypes.push(path);
        continue;
      }
      if (sha256(readFileSync(candidate)) !== expected) changed.push(path);
    } catch {
      missing.push(path);
    }
  }
  const base = {
    schema_version: "acceptance-source-revalidation/1" as const,
    checkpoint,
    acceptance_run_id: acceptanceRunId,
    checkpoint_id: randomUUID(),
    action_binding: Object.fromEntries(
      Object.entries(actionBinding).sort(([left], [right]) => left.localeCompare(right)),
    ),
    authority_binding: Object.fromEntries(
      Object.entries(authorityBinding).sort(([left], [right]) => left.localeCompare(right)),
    ),
    manifest_sha256: sha256(manifestBytes),
    manifest_canonical_sha256: manifestCanonicalSha256,
    governed_file_count: discovered.size,
    validated_at: new Date().toISOString(),
    result: "pass" as "pass" | "fail",
    missing_files: bounded(missing),
    unexpected_files: bounded(unexpected),
    changed_files: bounded(changed),
    invalid_file_types: bounded(invalidTypes),
  };
  base.result =
    base.manifest_sha256 === approved.artifact.acceptanceSourceManifestSha256 &&
    base.manifest_canonical_sha256 === approved.artifact.acceptanceSourceManifestCanonicalSha256 &&
    base.governed_file_count === Object.keys(approved.manifest.files).length &&
    !base.missing_files.length &&
    !base.unexpected_files.length &&
    !base.changed_files.length &&
    !base.invalid_file_types.length
      ? "pass"
      : "fail";
  return { ...base, binding_hash: sha256(canonicalJson(base)) };
}

export function revalidateFinalAcceptanceSource(args: {
  approved: ReturnType<typeof loadApprovedAcceptanceSource>;
  checkpoint: FinalAcceptanceSourceCheckpoint;
  acceptanceRunId: string;
  candidateBinding: Record<string, string>;
}) {
  if (!finalAcceptanceSourceCheckpoints.includes(args.checkpoint))
    throw new Error(`${ACCEPTANCE_SOURCE_CLOSURE_FAILURE}: invalid final checkpoint`);
  if (Object.values(args.candidateBinding).some((value) => !SHA256.test(value)))
    throw new Error(`${ACCEPTANCE_SOURCE_CLOSURE_FAILURE}: invalid final candidate binding`);
  const evidence = inspectFreshSource(
    args.approved,
    args.checkpoint,
    args.acceptanceRunId,
    { action: args.checkpoint, acceptance_run_id: args.acceptanceRunId },
    args.candidateBinding,
  );
  if (evidence.result !== "pass") throw new AcceptanceSourceClosureFailure(evidence);
  return evidence;
}

export class AcceptanceSourceCheckpointController {
  private readonly used = new Set<string>();
  private readonly minted = new Map<string, AcceptanceSourceRevalidationEvidence>();
  private next = 0;
  constructor(
    private readonly approved: ReturnType<typeof loadApprovedAcceptanceSource>,
    private readonly acceptanceRunId: string,
    private readonly persist: (evidence: AcceptanceSourceRevalidationEvidence) => void,
    private readonly authorityBinding: Record<string, string> = {
      artifact_sha256: "0".repeat(64),
      capability_manifest_sha256: "0".repeat(64),
      registry_content_sha256: "0".repeat(64),
      acceptance_contract_canonical_sha256: "0".repeat(64),
    },
  ) {}

  run<T>(
    checkpoint: AcceptanceSourceCheckpoint,
    actionBinding: Record<string, string>,
    action: (bindingHash: string) => T,
  ): T {
    if (acceptanceSourceCheckpoints[this.next] !== checkpoint)
      throw new Error(`${ACCEPTANCE_SOURCE_CLOSURE_FAILURE}: wrong lifecycle checkpoint ${checkpoint}`);
    validateActionBinding(checkpoint, actionBinding);
    const authorityKeys = [
      "acceptance_contract_canonical_sha256",
      "artifact_sha256",
      "capability_manifest_sha256",
      "registry_content_sha256",
    ];
    if (
      Object.keys(this.authorityBinding).sort().join("\n") !== authorityKeys.sort().join("\n") ||
      Object.values(this.authorityBinding).some((hash) => !SHA256.test(hash))
    )
      throw new Error(`${ACCEPTANCE_SOURCE_CLOSURE_FAILURE}: checkpoint authority binding is invalid`);
    const evidence = inspectFreshSource(
      this.approved,
      checkpoint,
      this.acceptanceRunId,
      actionBinding,
      this.authorityBinding,
    );
    this.minted.set(evidence.checkpoint_id, evidence);
    this.persist(evidence);
    if (evidence.result !== "pass") throw new AcceptanceSourceClosureFailure(evidence);
    this.consume(evidence, checkpoint, this.acceptanceRunId);
    this.next += 1;
    return action(evidence.binding_hash);
  }

  consume(
    evidence: AcceptanceSourceRevalidationEvidence,
    checkpoint: AcceptanceSourceCheckpoint,
    acceptanceRunId: string,
  ) {
    if (
      evidence.result !== "pass" ||
      evidence.checkpoint !== checkpoint ||
      evidence.acceptance_run_id !== acceptanceRunId ||
      evidence.manifest_sha256 !== this.approved.artifact.acceptanceSourceManifestSha256 ||
      evidence.binding_hash !==
        sha256(canonicalJson(Object.fromEntries(Object.entries(evidence).filter(([key]) => key !== "binding_hash")))) ||
      this.used.has(evidence.checkpoint_id) ||
      this.minted.get(evidence.checkpoint_id) !== evidence
    )
      throw new AcceptanceSourceCheckpointRejection("checkpoint_binding");
    this.used.add(evidence.checkpoint_id);
  }
}
