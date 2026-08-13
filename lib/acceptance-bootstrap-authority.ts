import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { canonicalJson } from "./canonical-json";
import { AcceptanceResourceInventory, type AcceptanceResourceCandidateBindings } from "./acceptance-resource-inventory";

const sha256 = (value: string | Buffer) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : Uint8Array.from(value))
    .digest("hex");

export type AcceptanceBootstrapRequest = Readonly<{
  acceptanceRunId?: string;
  acceptanceRoot: string;
  evidenceRoot: string;
  inventoryPath: string;
  candidateBindings: AcceptanceResourceCandidateBindings;
  launcherImplementationPath: string;
  expectedLauncherSha256: string;
  infrastructureLauncherPath: string;
  expectedInfrastructureLauncherSha256: string;
  infrastructureRequestSha256: string;
  createdAt?: string;
}>;

export function persistAcceptanceInventorySnapshot(path: string, bytes: string, replace = false) {
  if (!replace && existsSync(path)) throw new Error("Authoritative inventory already exists");
  const temporaryPath = `${path}.pending-${process.pid}-${randomUUID()}`;
  const descriptor = openSync(temporaryPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, bytes, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporaryPath, path);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

export function bootstrapAcceptanceRun(
  request: AcceptanceBootstrapRequest,
  hooks: { afterEvidenceRootCreated?: () => void; afterInventoryPersisted?: () => void } = {},
) {
  const acceptanceRoot = resolve(request.acceptanceRoot);
  const evidenceRoot = resolve(request.evidenceRoot);
  const inventoryPath = resolve(request.inventoryPath);
  if (
    evidenceRoot === acceptanceRoot ||
    !evidenceRoot.startsWith(`${acceptanceRoot}${sep}`) ||
    inventoryPath === acceptanceRoot ||
    !inventoryPath.startsWith(`${acceptanceRoot}${sep}`)
  )
    throw new Error("Bootstrap paths must remain inside the disposable acceptance root");
  const launcherSha256 = sha256(readFileSync(resolve(request.launcherImplementationPath)));
  if (launcherSha256 !== request.expectedLauncherSha256)
    throw new Error("Bootstrap launcher implementation identity changed");
  const infrastructureLauncherSha256 = sha256(readFileSync(resolve(request.infrastructureLauncherPath)));
  if (
    infrastructureLauncherSha256 !== request.expectedInfrastructureLauncherSha256 ||
    !/^[a-f0-9]{64}$/.test(request.infrastructureRequestSha256)
  )
    throw new Error("Infrastructure launcher or request identity changed");
  const requiredBindings = [
    "artifactSha256",
    "artifactMetadataSha256",
    "capabilityManifestSha256",
    "acceptanceSourceManifestSha256",
    "acceptanceContractSha256",
    "executableRegistrySha256",
    "validatorRegistrySha256",
    "disposableRegistrySha256",
    "realAcceptanceHarnessSha256",
  ];
  for (const binding of requiredBindings)
    if (
      !/^[a-f0-9]{64}$/.test(String(request.candidateBindings[binding as keyof typeof request.candidateBindings] ?? ""))
    )
      throw new Error(`Bootstrap candidate identity is missing or invalid: ${binding}`);
  const runId = request.acceptanceRunId ?? randomUUID();
  if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new Error("Bootstrap acceptance run ID is invalid");
  const createdAt = request.createdAt ?? new Date().toISOString();
  mkdirSync(evidenceRoot, { recursive: false, mode: 0o700 });
  hooks.afterEvidenceRootCreated?.();
  const inventory = new AcceptanceResourceInventory(
    runId,
    request.candidateBindings,
    String(request.candidateBindings.realAcceptanceHarnessSha256),
    createdAt,
  );
  const retentionPolicyIdentity = sha256(
    canonicalJson({
      policy: "runtime-v6-disposable-local-acceptance-evidence-retention",
      scope: "local_review_only",
      acceptanceRunId: runId,
    }),
  );
  inventory.register({
    resourceId: "acceptance-evidence-root",
    type: "evidence_directory",
    identity: {
      path: evidenceRoot,
      bootstrapLauncherSha256: launcherSha256,
      infrastructureLauncherSha256,
      infrastructureRequestSha256: request.infrastructureRequestSha256,
    },
    creatingStep: "bootstrap_authority.create_evidence_root",
    createdAt,
    cleanupPolicy: "retain_evidence_only",
    expectedTerminalState: "retained_with_approved_reason",
    retentionPolicyIdentity,
  });
  inventory.register({
    resourceId: "authoritative-resource-inventory",
    type: "other_run_scoped_resource",
    identity: {
      path: inventoryPath,
      bootstrapLauncherSha256: launcherSha256,
      infrastructureLauncherSha256,
      infrastructureRequestSha256: request.infrastructureRequestSha256,
    },
    creatingStep: "bootstrap_authority.persist_inventory",
    createdAt,
    cleanupPolicy: "retain_evidence_only",
    expectedTerminalState: "retained_with_approved_reason",
    retentionPolicyIdentity,
    dependsOn: ["acceptance-evidence-root"],
  });
  const snapshot = inventory.journalSnapshot();
  persistAcceptanceInventorySnapshot(inventoryPath, `${canonicalJson(snapshot)}\n`);
  hooks.afterInventoryPersisted?.();
  return Object.freeze({
    schemaVersion: "acceptance-bootstrap-handoff/1",
    acceptanceRunId: runId,
    inventoryPath,
    inventorySha256: snapshot.sha256,
    evidenceRoot,
    launcherSha256,
  });
}
