import { createHash, createPublicKey, verify } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  canonicalJson,
  canonicalReleaseManifestV3,
  parseCanonicalSignedReleaseManifestV3Json,
  publicKeyFingerprint,
  trustedReleaseKeys,
  verifyReleaseManifestV3,
} from "./release-authority";

export const REPLACEMENT_BOOTSTRAP_PROTOCOL = "operator-replacement-bootstrap-v1" as const;
export const REPLACEMENT_BOOTSTRAP_ID = "mission-agent-operator-bootstrap-0.6.8-to-0.7.2" as const;
export const NAMED_CANARY_ID = "0bd16e0e-98aa-4ab8-896a-f95d82ee5ad8" as const;
export const SOURCE_VERSION = "0.6.8" as const;
export const SOURCE_SHA256 = "e6cdf9d962231844b1887959411a8d262bf9371092eb0e789a4971ba3c3fc28d" as const;
export const TARGET_VERSION = "0.7.2" as const;
export const TARGET_SHA256 = "108e5587e8ffce0c37639e041cd2dcc2b51079f395beb04b26c1d4d9330bee09" as const;
export const TARGET_LENGTH = 148_063 as const;
export const TARGET_MANIFEST_SHA256 = "b9f7d17b54219a50f4298817db1bcece1fec49eb9311e27aa9a6f4f9a5947ace" as const;
export const TARGET_SIGNATURE_SHA256 = "4c86744ec6e8749b743b9130c65f23e6e2b324d3ccac3d0bf01c828b91d1a583" as const;
export const TARGET_KEY_ID = "mission-agent-release-2026-01" as const;
export const TARGET_KEY_FINGERPRINT =
  "ed25519-spki-sha256:7943a55a297cd50faf0a5841d06bcd0046d84dab73cc83543ba4021520706e8b" as const;
export const NODE_VERSION = "22.22.0" as const;
export const NODE_ARCHIVE_SHA256 = "5ed4db0fcf1eaf84d91ad12462631d73bf4576c1377e192d222e48026a902640" as const;
export const NODE_ARCHIVE_URL = "https://nodejs.org/dist/v22.22.0/node-v22.22.0-darwin-arm64.tar.gz" as const;
export const NODE_EXECUTABLE_SHA256 = "913b144fdb40638b1acef7974ab3c33fbd527cc0974cb5da467ab1e6ac51b4d4" as const;
export const NODE_INSTALL_ROOT = "/opt/mission-agent/runtime/node-22/22.22.0" as const;
export const NODE_EXECUTABLE = `${NODE_INSTALL_ROOT}/bin/node` as const;
export const NODE_PLATFORM = "darwin-arm64" as const;
export const NODE_ARCHIVE_LENGTH = 49_923_798 as const;
export const SERVICE_MANAGER = "launchd" as const;
export const SERVICE_IDENTIFIER = "com.wallyweb.mission-agent" as const;
export const APPROVED_AGENT_ROOT = "/Users/shawnwollenberg/.mission-agent" as const;
export const TARGET_SERVICE_PATH =
  "/Users/shawnwollenberg/.mission-agent/staged-0.7.2/com.wallyweb.mission-agent.plist" as const;
export const CURRENT_SERVICE_SHA256 = "3adfe6e3e0119871dcc8ba1977bc8af953accbcc51424eb13e1f1070f8789898" as const;
export const TARGET_SERVICE_SHA256 = "c81d2310df79224c41d71bdac2ea458f53b86caeed8b1543a474e955fa00dde6" as const;
export const ROLLBACK_INVENTORY_SHA256 = "2e7f074a890b1b6492ac76d1786b987c0a7417e50532a1e712699963b7e5f229" as const;

const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export const replacementStates = [
  "prepared",
  "approved",
  "draining",
  "verified",
  "staged",
  "replacing",
  "starting",
  "connected",
  "accepted",
  "completed",
  "failed",
  "rolling_back",
  "rolled_back",
  "revoked",
  "expired",
] as const;
export type ReplacementState = (typeof replacementStates)[number];

const transitions: Readonly<Record<ReplacementState, readonly ReplacementState[]>> = {
  prepared: ["approved", "revoked", "expired"],
  approved: ["draining", "revoked", "expired"],
  draining: ["verified", "failed", "revoked", "expired"],
  verified: ["staged", "failed", "revoked", "expired"],
  staged: ["replacing", "failed", "revoked", "expired"],
  replacing: ["starting", "failed", "rolling_back"],
  starting: ["connected", "failed", "rolling_back"],
  connected: ["accepted", "failed", "rolling_back"],
  accepted: ["completed", "failed", "rolling_back"],
  completed: [],
  failed: ["rolling_back"],
  rolling_back: ["rolled_back", "failed"],
  rolled_back: [],
  revoked: [],
  expired: [],
};

export type ReplacementAuthorization = {
  protocolVersion: typeof REPLACEMENT_BOOTSTRAP_PROTOCOL;
  authorizationId: string;
  agentId: typeof NAMED_CANARY_ID;
  hostIdentity: string;
  workspaceId: string;
  repositoryId: string;
  repositoryFingerprint: string;
  currentVersion: typeof SOURCE_VERSION;
  currentArtifactSha256: typeof SOURCE_SHA256;
  targetVersion: typeof TARGET_VERSION;
  targetArtifactSha256: typeof TARGET_SHA256;
  targetArtifactByteLength: typeof TARGET_LENGTH;
  targetManifestSha256: typeof TARGET_MANIFEST_SHA256;
  targetSignatureSha256: typeof TARGET_SIGNATURE_SHA256;
  targetSigningKeyId: typeof TARGET_KEY_ID;
  targetPublicKeyFingerprint: typeof TARGET_KEY_FINGERPRINT;
  requiredNodeVersion: typeof NODE_VERSION;
  nodeRuntime: {
    version: typeof NODE_VERSION;
    platform: typeof NODE_PLATFORM;
    distributionUrl: typeof NODE_ARCHIVE_URL;
    archiveSha256: typeof NODE_ARCHIVE_SHA256;
    archiveByteLength: typeof NODE_ARCHIVE_LENGTH;
    installationDirectory: typeof NODE_INSTALL_ROOT;
    executablePath: typeof NODE_EXECUTABLE;
    executableSha256: typeof NODE_EXECUTABLE_SHA256;
  };
  serviceReplacement: {
    serviceManager: typeof SERVICE_MANAGER;
    serviceIdentifier: typeof SERVICE_IDENTIFIER;
    currentDefinitionSha256: typeof CURRENT_SERVICE_SHA256;
    targetDefinitionSha256: typeof TARGET_SERVICE_SHA256;
    targetDefinitionPath: typeof TARGET_SERVICE_PATH;
    rollbackDefinitionSha256: typeof CURRENT_SERVICE_SHA256;
  };
  smokeMission: {
    templateId: "replacement-bootstrap-read-only-v1";
    operation: "repository-analysis";
    readOnly: true;
  };
  evidenceDestination: string;
  approvalId: string;
  operatorIdentity: string;
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
  maximumExecutionCount: 1;
  rollbackVersion: typeof SOURCE_VERSION;
  rollbackArtifactSha256: typeof SOURCE_SHA256;
  rollbackInventorySha256: typeof ROLLBACK_INVENTORY_SHA256;
  reason: "legacy-signing-authority-unavailable";
  legacyCryptographicContinuity: "unavailable";
  evidenceReferences: string[];
};

export type ReplacementRecord = {
  authorization: ReplacementAuthorization;
  authorizationChecksum: string;
  state: ReplacementState;
  version: number;
  executionCount: number;
  consumedAt: string | null;
  revokedAt: string | null;
  lastOccurredAt: string | null;
  lastEventChecksum: string | null;
};

export type ReplacementEvent = {
  eventId: string;
  authorizationId: string;
  workspaceId: string;
  operatorIdentity: string;
  from: ReplacementState;
  to: ReplacementState;
  version: number;
  occurredAt: string;
  evidenceChecksum: string;
  previousEventChecksum: string | null;
  checksum: string;
};

export function authorizationChecksum(value: ReplacementAuthorization): string {
  return sha256(canonicalJson(value));
}

export function validateReplacementAuthorization(
  value: ReplacementAuthorization,
  options: { now?: Date } = {},
): ReplacementAuthorization {
  const now = options.now ?? new Date();
  const exactKeys = [
    "protocolVersion",
    "authorizationId",
    "agentId",
    "hostIdentity",
    "workspaceId",
    "repositoryId",
    "repositoryFingerprint",
    "currentVersion",
    "currentArtifactSha256",
    "targetVersion",
    "targetArtifactSha256",
    "targetArtifactByteLength",
    "targetManifestSha256",
    "targetSignatureSha256",
    "targetSigningKeyId",
    "targetPublicKeyFingerprint",
    "requiredNodeVersion",
    "nodeRuntime",
    "serviceReplacement",
    "smokeMission",
    "evidenceDestination",
    "approvalId",
    "operatorIdentity",
    "approvedBy",
    "approvedAt",
    "expiresAt",
    "maximumExecutionCount",
    "rollbackVersion",
    "rollbackArtifactSha256",
    "rollbackInventorySha256",
    "reason",
    "legacyCryptographicContinuity",
    "evidenceReferences",
  ].sort();
  const exactNodeKeys = [
    "version",
    "platform",
    "distributionUrl",
    "archiveSha256",
    "archiveByteLength",
    "installationDirectory",
    "executablePath",
    "executableSha256",
  ].sort();
  const exactServiceKeys = [
    "serviceManager",
    "serviceIdentifier",
    "currentDefinitionSha256",
    "targetDefinitionSha256",
    "targetDefinitionPath",
    "rollbackDefinitionSha256",
  ].sort();
  if (
    canonicalJson(Object.keys(value).sort()) !== canonicalJson(exactKeys) ||
    canonicalJson(Object.keys(value.nodeRuntime ?? {}).sort()) !== canonicalJson(exactNodeKeys) ||
    canonicalJson(Object.keys(value.serviceReplacement ?? {}).sort()) !== canonicalJson(exactServiceKeys) ||
    canonicalJson(Object.keys(value.smokeMission ?? {}).sort()) !==
      canonicalJson(["operation", "readOnly", "templateId"])
  )
    throw new Error("Replacement authorization contains missing or unknown fields.");
  if (
    value.protocolVersion !== REPLACEMENT_BOOTSTRAP_PROTOCOL ||
    !UUID.test(value.authorizationId) ||
    value.agentId !== NAMED_CANARY_ID ||
    value.currentVersion !== SOURCE_VERSION ||
    value.currentArtifactSha256 !== SOURCE_SHA256 ||
    value.targetVersion !== TARGET_VERSION ||
    value.targetArtifactSha256 !== TARGET_SHA256 ||
    value.targetArtifactByteLength !== TARGET_LENGTH ||
    value.targetManifestSha256 !== TARGET_MANIFEST_SHA256 ||
    value.targetSignatureSha256 !== TARGET_SIGNATURE_SHA256 ||
    value.targetSigningKeyId !== TARGET_KEY_ID ||
    value.targetPublicKeyFingerprint !== TARGET_KEY_FINGERPRINT ||
    value.requiredNodeVersion !== NODE_VERSION ||
    value.nodeRuntime?.version !== NODE_VERSION ||
    value.nodeRuntime?.platform !== NODE_PLATFORM ||
    value.nodeRuntime?.distributionUrl !== NODE_ARCHIVE_URL ||
    value.nodeRuntime?.archiveSha256 !== NODE_ARCHIVE_SHA256 ||
    value.nodeRuntime?.archiveByteLength !== NODE_ARCHIVE_LENGTH ||
    value.nodeRuntime?.installationDirectory !== NODE_INSTALL_ROOT ||
    value.nodeRuntime?.executablePath !== NODE_EXECUTABLE ||
    value.nodeRuntime?.executableSha256 !== NODE_EXECUTABLE_SHA256 ||
    value.serviceReplacement?.serviceManager !== SERVICE_MANAGER ||
    value.serviceReplacement?.serviceIdentifier !== SERVICE_IDENTIFIER ||
    value.serviceReplacement?.currentDefinitionSha256 !== CURRENT_SERVICE_SHA256 ||
    value.serviceReplacement?.targetDefinitionSha256 !== TARGET_SERVICE_SHA256 ||
    value.serviceReplacement?.targetDefinitionPath !== TARGET_SERVICE_PATH ||
    value.serviceReplacement?.rollbackDefinitionSha256 !== CURRENT_SERVICE_SHA256 ||
    value.smokeMission?.templateId !== "replacement-bootstrap-read-only-v1" ||
    value.smokeMission?.operation !== "repository-analysis" ||
    value.smokeMission?.readOnly !== true ||
    value.maximumExecutionCount !== 1 ||
    value.rollbackVersion !== SOURCE_VERSION ||
    value.rollbackArtifactSha256 !== SOURCE_SHA256 ||
    value.rollbackInventorySha256 !== ROLLBACK_INVENTORY_SHA256 ||
    value.reason !== "legacy-signing-authority-unavailable" ||
    value.legacyCryptographicContinuity !== "unavailable"
  )
    throw new Error("Replacement authorization binding is invalid.");
  if (
    !value.hostIdentity ||
    !UUID.test(value.approvalId) ||
    !UUID.test(value.workspaceId) ||
    !UUID.test(value.repositoryId) ||
    !SHA256.test(value.repositoryFingerprint) ||
    !value.operatorIdentity ||
    !value.approvedBy ||
    !isAbsolute(value.evidenceDestination) ||
    resolve(value.evidenceDestination) !== value.evidenceDestination ||
    !value.evidenceDestination.startsWith(`${APPROVED_AGENT_ROOT}/evidence/`) ||
    value.evidenceReferences.length === 0
  )
    throw new Error("Replacement authorization scope is incomplete.");
  if (
    new Date(value.approvedAt).toISOString() !== value.approvedAt ||
    new Date(value.expiresAt).toISOString() !== value.expiresAt ||
    Date.parse(value.expiresAt) <= Date.parse(value.approvedAt) ||
    Date.parse(value.expiresAt) <= now.getTime()
  )
    throw new Error("Replacement authorization is expired or malformed.");
  return value;
}

export function createReplacementRecord(
  authorization: ReplacementAuthorization,
  options: { now?: Date } = {},
): ReplacementRecord {
  validateReplacementAuthorization(authorization, options);
  return {
    authorization,
    authorizationChecksum: authorizationChecksum(authorization),
    state: "prepared",
    version: 1,
    executionCount: 0,
    consumedAt: null,
    revokedAt: null,
    lastOccurredAt: null,
    lastEventChecksum: null,
  };
}

export function transitionReplacement(
  record: ReplacementRecord,
  input: {
    expectedVersion: number;
    to: ReplacementState;
    eventId: string;
    evidenceChecksum: string;
    occurredAt: string;
    operatorIdentity: string;
  },
): { record: ReplacementRecord; event: ReplacementEvent } {
  if (record.version !== input.expectedVersion) throw new Error("Replacement compare-and-set failed.");
  if (!transitions[record.state].includes(input.to)) throw new Error("Replacement state transition is invalid.");
  if (!UUID.test(input.eventId) || !SHA256.test(input.evidenceChecksum))
    throw new Error("Replacement event evidence is malformed.");
  const requiredPrincipal =
    input.to === "approved" ? record.authorization.approvedBy : record.authorization.operatorIdentity;
  if (input.operatorIdentity !== requiredPrincipal)
    throw new Error("Replacement transition principal is not authorized.");
  if (new Date(input.occurredAt).toISOString() !== input.occurredAt)
    throw new Error("Replacement event timestamp is malformed.");
  const occurredAt = Date.parse(input.occurredAt);
  if (
    occurredAt < Date.parse(record.authorization.approvedAt) ||
    (record.lastOccurredAt !== null && occurredAt <= Date.parse(record.lastOccurredAt)) ||
    (input.to !== "rolling_back" &&
      input.to !== "rolled_back" &&
      input.to !== "failed" &&
      occurredAt >= Date.parse(record.authorization.expiresAt))
  )
    throw new Error("Replacement event timestamp is outside the authorization window.");
  if (record.authorizationChecksum !== authorizationChecksum(record.authorization))
    throw new Error("Replacement authorization checksum mismatch.");
  if (record.executionCount >= 1 && input.to === "replacing")
    throw new Error("Replacement authorization has already been used.");
  const nextVersion = record.version + 1;
  const eventWithoutChecksum = {
    eventId: input.eventId,
    authorizationId: record.authorization.authorizationId,
    workspaceId: record.authorization.workspaceId,
    operatorIdentity: input.operatorIdentity,
    from: record.state,
    to: input.to,
    version: nextVersion,
    occurredAt: input.occurredAt,
    evidenceChecksum: input.evidenceChecksum,
    previousEventChecksum: record.lastEventChecksum,
  };
  const event: ReplacementEvent = { ...eventWithoutChecksum, checksum: sha256(canonicalJson(eventWithoutChecksum)) };
  return {
    event,
    record: {
      ...record,
      state: input.to,
      version: nextVersion,
      executionCount: input.to === "replacing" ? record.executionCount + 1 : record.executionCount,
      consumedAt: input.to === "completed" || input.to === "rolled_back" ? input.occurredAt : record.consumedAt,
      revokedAt: input.to === "revoked" ? input.occurredAt : record.revokedAt,
      lastOccurredAt: input.occurredAt,
      lastEventChecksum: event.checksum,
    },
  };
}

export function assertReplacementEligible(input: {
  record: ReplacementRecord;
  agentId: string;
  hostIdentity: string;
  currentVersion: string;
  currentArtifactSha256: string;
  workspaceId: string;
  repositoryId: string;
  repositoryFingerprint: string;
  healthy: boolean;
  drained: boolean;
  activeMission: boolean;
  activeLease: boolean;
  duplicateActiveAuthorizations: number;
  now?: Date;
}): void {
  const authorization = validateReplacementAuthorization(input.record.authorization, { now: input.now });
  if (
    input.record.authorizationChecksum !== authorizationChecksum(authorization) ||
    (input.record.state !== "approved" && input.record.state !== "staged") ||
    input.record.executionCount !== 0 ||
    input.agentId !== authorization.agentId ||
    input.hostIdentity !== authorization.hostIdentity ||
    input.currentVersion !== authorization.currentVersion ||
    input.currentArtifactSha256 !== authorization.currentArtifactSha256 ||
    input.workspaceId !== authorization.workspaceId ||
    input.repositoryId !== authorization.repositoryId ||
    input.repositoryFingerprint !== authorization.repositoryFingerprint ||
    !input.healthy ||
    !input.drained ||
    input.activeMission ||
    input.activeLease ||
    input.duplicateActiveAuthorizations !== 1
  )
    throw new Error("Replacement bootstrap is not eligible.");
}

export function verifyReplacementRelease(input: { signedManifestText: string; artifact: Uint8Array; now?: Date }): {
  manifestChecksum: string;
  artifactChecksum: string;
  standaloneVerified: true;
} {
  const bundle = parseCanonicalSignedReleaseManifestV3Json(input.signedManifestText);
  const { signature, ...manifest } = bundle;
  const canonicalManifest = canonicalReleaseManifestV3(manifest);
  const manifestChecksum = sha256(canonicalManifest);
  const signatureBytes = Buffer.from(signature, "base64");
  if (
    manifestChecksum !== TARGET_MANIFEST_SHA256 ||
    sha256(Uint8Array.from(signatureBytes)) !== TARGET_SIGNATURE_SHA256
  )
    throw new Error("Replacement release manifest or signature checksum mismatch.");
  const verified = verifyReleaseManifestV3(bundle, { now: input.now });
  const key = trustedReleaseKeys[verified.signingKeyId];
  if (
    verified.releaseVersion !== TARGET_VERSION ||
    verified.artifactSha256 !== TARGET_SHA256 ||
    verified.artifactByteLength !== TARGET_LENGTH ||
    verified.signingKeyId !== TARGET_KEY_ID ||
    verified.publicKeyFingerprint !== TARGET_KEY_FINGERPRINT ||
    publicKeyFingerprint(key.publicKeySpkiBase64) !== TARGET_KEY_FINGERPRINT
  )
    throw new Error("Replacement release binding mismatch.");
  const publicKey = createPublicKey({
    key: Buffer.from(key.publicKeySpkiBase64, "base64"),
    format: "der",
    type: "spki",
  });
  if (!verify(null, Uint8Array.from(Buffer.from(canonicalManifest)), publicKey, Uint8Array.from(signatureBytes)))
    throw new Error("Standalone replacement signature verification failed.");
  const artifactChecksum = sha256(input.artifact);
  if (input.artifact.byteLength !== TARGET_LENGTH || artifactChecksum !== TARGET_SHA256)
    throw new Error("Replacement artifact length or checksum mismatch.");
  return { manifestChecksum, artifactChecksum, standaloneVerified: true };
}

export function validateNodeRuntimePlan(input: {
  archiveUrl: string;
  archiveSha256: string;
  executablePath: string;
  reportedVersion: string;
  executableSha256: string;
  executableMode: number;
}): void {
  if (
    input.archiveUrl !== NODE_ARCHIVE_URL ||
    input.archiveSha256 !== NODE_ARCHIVE_SHA256 ||
    input.executablePath !== NODE_EXECUTABLE ||
    !isAbsolute(input.executablePath) ||
    input.reportedVersion !== `v${NODE_VERSION}` ||
    input.executableSha256 !== NODE_EXECUTABLE_SHA256 ||
    (input.executableMode & 0o111) === 0
  )
    throw new Error("Isolated Node 22 runtime validation failed.");
}

export function renderLaunchAgent(input: {
  nodeExecutable: string;
  agentArtifact: string;
  agentHome: string;
  stdoutPath: string;
  stderrPath: string;
}): string {
  for (const value of Object.values(input))
    if (!isAbsolute(value)) throw new Error("LaunchAgent paths must be absolute.");
  if (input.nodeExecutable !== NODE_EXECUTABLE || !input.agentArtifact.endsWith("/mission-agent-0.7.2.mjs"))
    throw new Error("LaunchAgent executable binding is invalid.");
  const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.wallyweb.mission-agent</string><key>ProgramArguments</key><array><string>${xml(input.nodeExecutable)}</string><string>${xml(input.agentArtifact)}</string><string>run</string></array><key>EnvironmentVariables</key><dict><key>MISSION_AGENT_HOME</key><string>${xml(input.agentHome)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${xml(input.stdoutPath)}</string><key>StandardErrorPath</key><string>${xml(input.stderrPath)}</string></dict></plist>\n`;
}

export async function stageAtomicReplacement(input: {
  root: string;
  artifact: Uint8Array;
  launchAgent: string;
  existingArtifact: string;
  existingLaunchAgent: string;
}): Promise<{ stagedArtifact: string; stagedLaunchAgent: string; rollbackDirectory: string }> {
  const rollbackDirectory = join(input.root, "rollback-0.6.8");
  const stageDirectory = join(input.root, "staged-0.7.2");
  await mkdir(rollbackDirectory, { recursive: true, mode: 0o700 });
  await mkdir(stageDirectory, { recursive: true, mode: 0o700 });
  const existingArtifactBytes = await readFile(input.existingArtifact);
  if (existingArtifactBytes.byteLength === 0 || sha256(Uint8Array.from(existingArtifactBytes)) !== SOURCE_SHA256)
    throw new Error("Existing Mission Agent 0.6.8 bytes do not match the rollback binding.");
  await copyFile(input.existingArtifact, join(rollbackDirectory, "mission-agent-0.6.8.mjs"), constants.COPYFILE_EXCL);
  await copyFile(
    input.existingLaunchAgent,
    join(rollbackDirectory, "com.wallyweb.mission-agent.plist"),
    constants.COPYFILE_EXCL,
  );
  const stagedArtifactTemporary = join(stageDirectory, "mission-agent-0.7.2.mjs.tmp");
  const stagedArtifact = join(stageDirectory, "mission-agent-0.7.2.mjs");
  await writeFile(stagedArtifactTemporary, input.artifact, { mode: 0o700 });
  if (
    (await stat(stagedArtifactTemporary)).size !== TARGET_LENGTH ||
    sha256(Uint8Array.from(await readFile(stagedArtifactTemporary))) !== TARGET_SHA256
  )
    throw new Error("Staged replacement artifact verification failed.");
  await rename(stagedArtifactTemporary, stagedArtifact);
  await chmod(stagedArtifact, 0o700);
  const stagedLaunchAgentTemporary = join(stageDirectory, "com.wallyweb.mission-agent.plist.tmp");
  const stagedLaunchAgent = join(stageDirectory, "com.wallyweb.mission-agent.plist");
  await writeFile(stagedLaunchAgentTemporary, input.launchAgent, { mode: 0o600 });
  await rename(stagedLaunchAgentTemporary, stagedLaunchAgent);
  return { stagedArtifact, stagedLaunchAgent, rollbackDirectory };
}

export async function verifyInstalledNodeRuntime(): Promise<void> {
  const executable = await stat(NODE_EXECUTABLE);
  const executableBytes = await readFile(NODE_EXECUTABLE);
  if (
    !executable.isFile() ||
    executable.uid !== 0 ||
    (executable.mode & 0o022) !== 0 ||
    (executable.mode & 0o111) === 0 ||
    sha256(Uint8Array.from(executableBytes)) !== NODE_EXECUTABLE_SHA256
  )
    throw new Error("Installed Node runtime ownership, permissions, or checksum is invalid.");
}

export type ReplacementServiceControl = {
  stopNamedAgent(agentId: typeof NAMED_CANARY_ID): Promise<void>;
  startNamedAgent(agentId: typeof NAMED_CANARY_ID): Promise<void>;
  verifyStopped(agentId: typeof NAMED_CANARY_ID): Promise<boolean>;
  verifyAccepted(input: {
    agentId: typeof NAMED_CANARY_ID;
    version: typeof TARGET_VERSION;
    artifactSha256: typeof TARGET_SHA256;
    workspaceId: string;
    repositoryId: string;
    repositoryFingerprint: string;
  }): Promise<boolean>;
};

async function atomicInstall(source: string, destination: string): Promise<void> {
  const temporary = `${destination}.replacement-tmp`;
  await copyFile(source, temporary, constants.COPYFILE_EXCL);
  await rename(temporary, destination);
}

type ReplacementHostJournal = {
  protocolVersion: typeof REPLACEMENT_BOOTSTRAP_PROTOCOL;
  agentId: typeof NAMED_CANARY_ID;
  authorizationChecksum: string;
  phase:
    | "staged"
    | "stop_requested"
    | "stopped"
    | "artifact_installed"
    | "service_installed"
    | "start_requested"
    | "accepted"
    | "rolled_back";
  activeArtifact: string;
  activeLaunchAgent: string;
  rollbackDirectory: string;
  checksum: string;
};

const journalFile = (stagingRoot: string) => join(stagingRoot, "replacement-host-journal.json");

async function writeHostJournal(stagingRoot: string, value: Omit<ReplacementHostJournal, "checksum">): Promise<void> {
  const checksum = sha256(canonicalJson(value));
  const temporary = `${journalFile(stagingRoot)}.tmp`;
  await writeFile(temporary, `${canonicalJson({ ...value, checksum })}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, journalFile(stagingRoot));
}

async function readHostJournal(stagingRoot: string): Promise<ReplacementHostJournal | null> {
  try {
    const value = JSON.parse(await readFile(journalFile(stagingRoot), "utf8")) as ReplacementHostJournal;
    const { checksum, ...unsigned } = value;
    if (!SHA256.test(checksum) || sha256(canonicalJson(unsigned)) !== checksum)
      throw new Error("Replacement host journal checksum is invalid.");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function recoverInterruptedReplacement(input: {
  record: ReplacementRecord;
  activeArtifact: string;
  activeLaunchAgent: string;
  stagingRoot: string;
  service: ReplacementServiceControl;
}): Promise<"none" | "accepted" | "rolled_back"> {
  const journal = await readHostJournal(input.stagingRoot);
  if (!journal) return "none";
  if (
    journal.protocolVersion !== REPLACEMENT_BOOTSTRAP_PROTOCOL ||
    journal.agentId !== NAMED_CANARY_ID ||
    journal.authorizationChecksum !== input.record.authorizationChecksum ||
    journal.activeArtifact !== input.activeArtifact ||
    journal.activeLaunchAgent !== input.activeLaunchAgent ||
    journal.rollbackDirectory !== join(input.stagingRoot, "rollback-0.6.8")
  )
    throw new Error("Replacement host journal binding is invalid.");
  if (journal.phase === "accepted") return "accepted";
  if (journal.phase === "rolled_back") return "rolled_back";
  const journalWithoutChecksum = Object.fromEntries(
    Object.entries(journal).filter(([key]) => key !== "checksum"),
  ) as Omit<ReplacementHostJournal, "checksum">;

  const rollbackArtifact = join(journal.rollbackDirectory, "mission-agent-0.6.8.mjs");
  const rollbackLaunchAgent = join(journal.rollbackDirectory, "com.wallyweb.mission-agent.plist");
  const possiblyMutated = ["artifact_installed", "service_installed", "start_requested"].includes(journal.phase);
  let stopped = await input.service.verifyStopped(NAMED_CANARY_ID);
  if (possiblyMutated && !stopped) {
    await input.service.stopNamedAgent(NAMED_CANARY_ID);
    stopped = await input.service.verifyStopped(NAMED_CANARY_ID);
    if (!stopped) throw new Error("Interrupted replacement could not stop the named agent for rollback.");
  }
  if (stopped || possiblyMutated) {
    await atomicInstall(rollbackArtifact, input.activeArtifact);
    await atomicInstall(rollbackLaunchAgent, input.activeLaunchAgent);
    if (sha256(Uint8Array.from(await readFile(input.activeArtifact))) !== SOURCE_SHA256)
      throw new Error("Interrupted replacement rollback checksum verification failed.");
    await input.service.startNamedAgent(NAMED_CANARY_ID);
  }
  await writeHostJournal(input.stagingRoot, { ...journalWithoutChecksum, phase: "rolled_back" });
  return "rolled_back";
}

export async function executeAtomicReplacement(input: {
  record: ReplacementRecord;
  signedManifestText: string;
  artifact: Uint8Array;
  activeArtifact: string;
  activeLaunchAgent: string;
  stagingRoot: string;
  launchAgent: string;
  service: ReplacementServiceControl;
  verifyNodeRuntime?: () => Promise<void>;
}): Promise<{ accepted: true; rollbackDirectory: string }> {
  const authorization = validateReplacementAuthorization(input.record.authorization);
  if (
    input.record.state !== "replacing" ||
    input.record.executionCount !== 1 ||
    input.record.authorizationChecksum !== authorizationChecksum(authorization)
  )
    throw new Error("A durably consumed replacement execution permit is required.");
  const recovered = await recoverInterruptedReplacement(input);
  if (recovered !== "none") throw new Error(`Existing replacement host journal is terminal: ${recovered}.`);
  verifyReplacementRelease({ signedManifestText: input.signedManifestText, artifact: input.artifact });
  await (input.verifyNodeRuntime ?? verifyInstalledNodeRuntime)();
  const staged = await stageAtomicReplacement({
    root: input.stagingRoot,
    artifact: input.artifact,
    launchAgent: input.launchAgent,
    existingArtifact: input.activeArtifact,
    existingLaunchAgent: input.activeLaunchAgent,
  });
  const rollbackArtifact = join(staged.rollbackDirectory, "mission-agent-0.6.8.mjs");
  const rollbackLaunchAgent = join(staged.rollbackDirectory, "com.wallyweb.mission-agent.plist");
  const journalBase = {
    protocolVersion: REPLACEMENT_BOOTSTRAP_PROTOCOL,
    agentId: NAMED_CANARY_ID,
    authorizationChecksum: input.record.authorizationChecksum,
    activeArtifact: input.activeArtifact,
    activeLaunchAgent: input.activeLaunchAgent,
    rollbackDirectory: staged.rollbackDirectory,
  } as const;
  await writeHostJournal(input.stagingRoot, { ...journalBase, phase: "staged" });
  let stopped = false;
  try {
    await writeHostJournal(input.stagingRoot, { ...journalBase, phase: "stop_requested" });
    await input.service.stopNamedAgent(NAMED_CANARY_ID);
    stopped = true;
    if (!(await input.service.verifyStopped(NAMED_CANARY_ID)))
      throw new Error("Named Mission Agent did not enter a stopped state.");
    await writeHostJournal(input.stagingRoot, { ...journalBase, phase: "stopped" });
    await atomicInstall(staged.stagedArtifact, input.activeArtifact);
    await writeHostJournal(input.stagingRoot, { ...journalBase, phase: "artifact_installed" });
    await atomicInstall(staged.stagedLaunchAgent, input.activeLaunchAgent);
    await writeHostJournal(input.stagingRoot, { ...journalBase, phase: "service_installed" });
    if (sha256(Uint8Array.from(await readFile(input.activeArtifact))) !== TARGET_SHA256)
      throw new Error("Activated Mission Agent bytes do not match the authorized target.");
    await writeHostJournal(input.stagingRoot, { ...journalBase, phase: "start_requested" });
    await input.service.startNamedAgent(NAMED_CANARY_ID);
    if (
      !(await input.service.verifyAccepted({
        agentId: NAMED_CANARY_ID,
        version: TARGET_VERSION,
        artifactSha256: TARGET_SHA256,
        workspaceId: authorization.workspaceId,
        repositoryId: authorization.repositoryId,
        repositoryFingerprint: authorization.repositoryFingerprint,
      }))
    )
      throw new Error("Replacement startup, identity, heartbeat, or capability acceptance failed.");
    await writeHostJournal(input.stagingRoot, { ...journalBase, phase: "accepted" });
    return { accepted: true, rollbackDirectory: staged.rollbackDirectory };
  } catch (error) {
    if (stopped) {
      await atomicInstall(rollbackArtifact, input.activeArtifact);
      await atomicInstall(rollbackLaunchAgent, input.activeLaunchAgent);
      if (sha256(Uint8Array.from(await readFile(input.activeArtifact))) !== SOURCE_SHA256)
        throw new AggregateError([error], "Replacement failed and rollback checksum verification failed.");
      await input.service.startNamedAgent(NAMED_CANARY_ID);
    }
    await writeHostJournal(input.stagingRoot, { ...journalBase, phase: "rolled_back" });
    throw error;
  }
}
