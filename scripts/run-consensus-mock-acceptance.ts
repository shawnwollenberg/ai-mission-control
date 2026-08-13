import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bootstrapAcceptanceRun } from "../lib/acceptance-bootstrap-authority";
import { canonicalHash } from "../lib/canonical-json";
import { providerRuntimeProfileBinding } from "../domain/provider-runtime-profiles";
import { assertCurrentStandaloneAuthority } from "../lib/acceptance-standalone-authority";
import {
  acceptanceValidatorRegistryIdentity,
  type GeneratedAcceptanceContract,
} from "./consensus-real-acceptance-steps";

const sha = (path: string) =>
  createHash("sha256")
    .update(Uint8Array.from(readFileSync(resolve(path))))
    .digest("hex");
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Mock acceptance launcher requires ${name}`);
  return value;
};
if (process.env.APP_ENV !== "disposable_acceptance")
  throw new Error("Mock acceptance launcher is unavailable outside disposable acceptance");
const providerRuntimeMode = process.env.CONSENSUS_PROVIDER_RUNTIME_MODE;
if (!["mock_provider_acceptance", "consensus_real_provider_acceptance"].includes(providerRuntimeMode ?? ""))
  throw new Error("Acceptance launcher requires an explicit governed provider runtime mode");
const authenticatedProviderAcceptance = providerRuntimeMode === "consensus_real_provider_acceptance";

const standaloneAuthorityFiles = [
  "app/api/agent-protocol/v1/messages/route.ts",
  "application/acceptance-authority-presentation-observations.ts",
  "application/remote-agent-messages.ts",
] as const;
assertCurrentStandaloneAuthority({
  receiptPath: ".next/standalone/.next/acceptance-authority-build.json",
  authoritySources: standaloneAuthorityFiles,
});

const root = resolve(required("CONSENSUS_ACCEPTANCE_ROOT"));
// Node canonicalizes import.meta.url through the macOS /tmp -> /private/tmp
// symlink. Invoke the executable by the same canonical path so its guarded CLI
// entrypoint cannot silently be skipped by lexical-path inequality.
const artifactPath = realpathSync(resolve(required("CONSENSUS_ACCEPTANCE_ARTIFACT")));
const authorizationSource = resolve(
  required(
    authenticatedProviderAcceptance
      ? "MISSION_AGENT_LOCAL_ACCEPTANCE_REGISTRY"
      : "MISSION_CONTROL_LOCAL_VALIDATION_AUTHORIZATION",
  ),
);
const authorization = JSON.parse(readFileSync(authorizationSource, "utf8"));
const approvedPacket = authenticatedProviderAcceptance ? authorization.artifacts?.["0.8.0"] : authorization.artifact;
if (!approvedPacket) throw new Error("Acceptance authority does not bind Mission Agent 0.8.0");
const contract = JSON.parse(
  readFileSync(resolve("domain/consensus-real-provider-acceptance-contract.json"), "utf8"),
) as GeneratedAcceptanceContract;
const runId = process.env.CONSENSUS_ACCEPTANCE_RUN_ID ?? randomUUID();
const databasePort = Number(required("CONSENSUS_ACCEPTANCE_POSTGRES_PORT"));
const applicationPort = Number(required("CONSENSUS_ACCEPTANCE_APP_PORT"));
const databaseName = `mc_disposable_acceptance_${runId.replaceAll("-", "_")}`;
const databaseUrl = `postgresql://mission_control@127.0.0.1:${databasePort}/${databaseName}`;
const publicUrl = `http://127.0.0.1:${applicationPort}`;
const evidenceRoot = join(root, "evidence");
const inventoryPath = join(evidenceRoot, "resource-inventory.json");
const infrastructureRequestPath = join(root, "infrastructure-request.json");
const authorizationDirectory = join(root, "validation-authorization");
const authorizationPath = join(authorizationDirectory, "authorization.json");
const postgresData = join(root, "postgres-data");
const artifactStorageRoot = join(root, "artifacts");
const providerWritableRoots = [
  {
    resourceId: "provider-writable-root-artifacts",
    path: artifactStorageRoot,
    agentProviderIdentity: "mission-control",
    providerRuntimeProfile: "artifact-storage-local",
    rootPurpose: "artifact_staging",
  },
  {
    resourceId: "provider-writable-root-codex",
    path: join(root, "agent-codex"),
    agentProviderIdentity: "codex",
    providerRuntimeProfile: "codex-planning-and-implementation-macos-v2",
    rootPurpose: "agent_runtime",
  },
  {
    resourceId: "provider-writable-root-claude-code",
    path: join(root, "agent-claude_code"),
    agentProviderIdentity: "claude_code",
    providerRuntimeProfile: "claude-planning-and-implementation-macos-v2",
    rootPurpose: "agent_runtime",
  },
  {
    resourceId: "provider-writable-root-mock-fixture",
    path: join(root, "consensus-acceptance-fixture"),
    agentProviderIdentity: "mock",
    providerRuntimeProfile: "mock-provider-acceptance",
    rootPurpose: "fixture_runtime",
  },
  {
    resourceId: "provider-writable-root-worktrees",
    path: join(root, "worktrees"),
    agentProviderIdentity: "codex",
    providerRuntimeProfile: "codex-implementation-macos-v2",
    rootPurpose: "worktree_parent",
  },
] as const;
const providerRequirements = JSON.parse(readFileSync(resolve("domain/provider-runtime-requirements.json"), "utf8"));
const providerProfiles = JSON.parse(readFileSync(resolve("domain/provider-runtime-profiles.proposed.json"), "utf8"));
const currentRuntimeBindings = Object.fromEntries(
  Object.keys(providerProfiles.profiles).map((id) => [id, providerRuntimeProfileBinding(id).runtimeBindingHash]),
);
const candidateBindings = {
  artifactSha256: approvedPacket.sha256,
  artifactMetadataSha256: approvedPacket.artifactMetadataSha256,
  capabilityManifestSha256: approvedPacket.capabilityManifestSha256,
  acceptanceSourceManifestSha256: approvedPacket.acceptanceSourceManifestCanonicalSha256,
  acceptanceContractSha256: canonicalHash(contract),
  executableRegistrySha256: approvedPacket.acceptanceExecutableRegistryCanonicalSha256,
  disposableRegistrySha256: sha(authorizationSource),
  providerRequirementsSha256: canonicalHash(providerRequirements),
  providerProfilesSha256: canonicalHash(providerProfiles),
  runtimeBindingsSha256: canonicalHash(currentRuntimeBindings),
  modelAssignmentsSha256: canonicalHash(approvedPacket.modelAllowlist),
  validatorRegistrySha256: acceptanceValidatorRegistryIdentity(contract),
  reviewChecklistSha256: sha("docs/evidence/MISSION_AGENT_080_RUNTIME_V6_REVIEW_CHECKLIST.json"),
  finalizerChecklistSha256: sha("docs/evidence/MISSION_AGENT_080_RUNTIME_V6_FINALIZER_CHECKLIST.json"),
  reviewerImplementationSha256: sha("scripts/review-consensus-acceptance-evidence.ts"),
  resourceInventoryImplementationSha256: sha("lib/acceptance-resource-inventory.ts"),
  cleanupFinalizerSha256: sha("scripts/finalize-consensus-real-acceptance.ts"),
  realAcceptanceHarnessSha256: sha("scripts/run-consensus-real-acceptance.ts"),
};
const databaseUrlSha256 = createHash("sha256").update(databaseUrl).digest("hex");
const authorizationSha256 = sha(authorizationSource);
const createdAt = new Date().toISOString();
const infrastructureRequest = {
  bootstrapInventoryPath: inventoryPath,
  resources: [
    ...providerWritableRoots.map((providerRoot) => ({
      record: {
        resourceId: providerRoot.resourceId,
        type: "sandbox_root" as const,
        identity: {
          runId,
          candidateArtifactSha256: candidateBindings.artifactSha256,
          agentProviderIdentity: providerRoot.agentProviderIdentity,
          providerRuntimeProfile: providerRoot.providerRuntimeProfile,
          intendedPath: providerRoot.path,
          rootPurpose: providerRoot.rootPurpose,
        },
        creatingStep: "bootstrap.provider_writable_root",
        createdAt,
        cleanupPolicy: "delete" as const,
        expectedTerminalState: "deleted" as const,
      },
      creation: { kind: "directory" as const, path: providerRoot.path },
    })),
    {
      record: {
        resourceId: "postgres-data-directory",
        type: "postgres_data_directory",
        identity: {
          intendedPath: postgresData,
          acceptanceRunId: runId,
          candidateArtifactSha256: candidateBindings.artifactSha256,
          databaseServiceResourceId: "database-service",
          host: "127.0.0.1",
          port: databasePort,
        },
        creatingStep: "infrastructure.postgres_data_directory",
        createdAt,
        cleanupPolicy: "delete",
        expectedTerminalState: "deleted",
      },
      creation: { kind: "directory", path: postgresData },
    },
    {
      record: {
        resourceId: "database-service",
        type: "database_process",
        identity: { executable: process.execPath, dataDirectory: postgresData },
        creatingStep: "infrastructure.database_service",
        createdAt,
        cleanupPolicy: "stop",
        expectedTerminalState: "stopped",
        dependsOn: ["postgres-data-directory"],
      },
      creation: {
        kind: "process",
        executable: process.execPath,
        args: [resolve("scripts/run-disposable-acceptance-postgres.mjs")],
        cwd: resolve("."),
      },
    },
    {
      record: {
        resourceId: "disposable-registry-copy",
        type: "registry_copy",
        identity: { intendedPath: authorizationDirectory },
        creatingStep: "infrastructure.validation_authorization",
        createdAt,
        cleanupPolicy: "delete",
        expectedTerminalState: "deleted",
      },
      creation: {
        kind: "command",
        executable: "/bin/sh",
        args: [
          "-c",
          `mkdir -m 700 '${authorizationDirectory}'; cp '${authorizationSource}' '${authorizationPath}'; chmod 400 '${authorizationPath}'; chmod 500 '${authorizationDirectory}'`,
        ],
        cwd: resolve("."),
        actualIdentity: { path: authorizationDirectory, sha256: authorizationSha256 },
      },
    },
    {
      record: {
        resourceId: "disposable-database",
        type: "disposable_database",
        identity: { databaseUrlSha256, databaseName },
        creatingStep: "infrastructure.database_migration",
        createdAt,
        cleanupPolicy: "delete",
        expectedTerminalState: "deleted",
        dependsOn: ["database-service"],
      },
      creation: {
        kind: "command",
        executable: "/bin/sh",
        args: [
          "-c",
          `until /usr/local/opt/postgresql@17/bin/pg_isready -h 127.0.0.1 -p ${databasePort}; do sleep 0.1; done; /usr/local/opt/postgresql@17/bin/createdb -h 127.0.0.1 -p ${databasePort} -U mission_control ${databaseName}; npm run db:migrate`,
        ],
        cwd: resolve("."),
        actualIdentity: { databaseUrlSha256, databaseName },
      },
    },
    {
      record: {
        resourceId: "mission-control-listener",
        type: "listener",
        identity: {
          host: "127.0.0.1",
          port: applicationPort,
          generation: "initial",
          owningServerResourceId: "mission-control-server",
        },
        creatingStep: "infrastructure.listener",
        createdAt,
        cleanupPolicy: "stop",
        expectedTerminalState: "stopped",
      },
      creation: {
        kind: "command",
        executable: "/bin/sh",
        args: ["-c", "/usr/bin/true"],
        cwd: resolve("."),
        actualIdentity: {
          host: "127.0.0.1",
          port: applicationPort,
          generation: "initial",
          owningServerResourceId: "mission-control-server",
        },
      },
    },
    {
      record: {
        resourceId: "mission-control-server",
        type: "mission_control_server",
        identity: { executable: process.execPath, generation: "initial" },
        creatingStep: "infrastructure.mission_control_server",
        createdAt,
        cleanupPolicy: "stop",
        expectedTerminalState: "stopped",
        dependsOn: ["mission-control-listener", "disposable-database", "disposable-registry-copy"],
      },
      creation: {
        kind: "process",
        executable: process.execPath,
        args: [resolve(".next/standalone/server.js")],
        cwd: resolve("."),
        readyUrl: `${publicUrl}/api/health`,
      },
    },
  ],
};

mkdirSync(root, { recursive: false, mode: 0o700 });
writeFileSync(infrastructureRequestPath, `${JSON.stringify(infrastructureRequest, null, 2)}\n`, { mode: 0o600 });
const infrastructureRequestSha256 = sha(infrastructureRequestPath);
bootstrapAcceptanceRun({
  acceptanceRunId: runId,
  acceptanceRoot: root,
  evidenceRoot,
  inventoryPath,
  candidateBindings,
  launcherImplementationPath: resolve("scripts/bootstrap-consensus-real-acceptance.ts"),
  expectedLauncherSha256: sha("scripts/bootstrap-consensus-real-acceptance.ts"),
  infrastructureLauncherPath: resolve("scripts/launch-consensus-acceptance-infrastructure.ts"),
  expectedInfrastructureLauncherSha256: sha("scripts/launch-consensus-acceptance-infrastructure.ts"),
  infrastructureRequestSha256,
  createdAt,
});

const childEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  APP_ENV: "disposable_acceptance",
  NODE_ENV: "production",
  HOSTNAME: "127.0.0.1",
  PORT: String(applicationPort),
  DATABASE_URL: databaseUrl,
  DISPOSABLE_ACCEPTANCE_DATABASE_NAME: databaseName,
  CONSENSUS_ACCEPTANCE_RUN_ID: runId,
  CONSENSUS_ACCEPTANCE_ROOT: root,
  DISPOSABLE_ACCEPTANCE_ROOT: root,
  ARTIFACT_STORAGE_PROVIDER: "local",
  ARTIFACT_STORAGE_ROOT: artifactStorageRoot,
  PUBLIC_APP_URL: publicUrl,
  CONSENSUS_ACCEPTANCE_URL: publicUrl,
  MISSION_CONTROL_PUBLIC_URL: publicUrl,
  MISSION_CONTROL_PROTOCOL_URL: publicUrl,
  MISSION_CONTROL_HEALTH_URL: `${publicUrl}/api/health`,
  CONSENSUS_DISPOSABLE_ACCEPTANCE: "true",
  CONSENSUS_PROVIDER_RUNTIME_MODE: providerRuntimeMode,
  MISSION_AGENT_PROVIDER_RUNTIME_MODE: providerRuntimeMode,
  CONSENSUS_ACCEPTANCE_ARTIFACT: artifactPath,
  CONSENSUS_ACCEPTANCE_BOOTSTRAP_INVENTORY: inventoryPath,
  CONSENSUS_ACCEPTANCE_INFRASTRUCTURE_REQUEST: infrastructureRequestPath,
  DISPOSABLE_ACCEPTANCE_PROVIDER_WRITABLE_ROOTS: JSON.stringify(providerWritableRoots.map((row) => row.path)),
  CONSENSUS_ACCEPTANCE_POSTGRES_DATA: postgresData,
  CONSENSUS_ACCEPTANCE_POSTGRES_PORT: String(databasePort),
  MISSION_CONTROL_SESSION_SECRET: randomBytes(48).toString("base64url"),
  SECRET_PROVIDER: "disposable_local_reference_only",
  PROJECT_BRAIN_LOCAL_EXECUTION: "enabled",
  PROJECT_BRAIN_EXECUTABLE: process.env.PROJECT_BRAIN_EXECUTABLE ?? "project-brain",
  CODEX_REPOSITORY_ROOT: root,
  CODEX_WORKTREE_ROOT: join(root, "worktrees"),
};
if (authenticatedProviderAcceptance) {
  childEnvironment.MISSION_AGENT_LOCAL_ACCEPTANCE_REGISTRY = authorizationPath;
  childEnvironment.MISSION_AGENT_LOCAL_ACCEPTANCE_REGISTRY_SHA256 = authorizationSha256;
  delete childEnvironment.MISSION_CONTROL_LOCAL_VALIDATION_AUTHORIZATION;
  delete childEnvironment.MISSION_CONTROL_LOCAL_VALIDATION_AUTHORIZATION_SHA256;
  delete childEnvironment.MISSION_AGENT_MOCK_VALIDATION_AUTHORIZATION;
  delete childEnvironment.MISSION_AGENT_MOCK_VALIDATION_AUTHORIZATION_SHA256;
  delete childEnvironment.MISSION_AGENT_MOCK_RUNTIME_PATH;
} else {
  childEnvironment.MISSION_CONTROL_LOCAL_VALIDATION_AUTHORIZATION = authorizationPath;
  childEnvironment.MISSION_CONTROL_LOCAL_VALIDATION_AUTHORIZATION_SHA256 = authorizationSha256;
  childEnvironment.MISSION_AGENT_MOCK_VALIDATION_AUTHORIZATION = authorizationPath;
  childEnvironment.MISSION_AGENT_MOCK_VALIDATION_AUTHORIZATION_SHA256 = authorizationSha256;
  childEnvironment.MISSION_AGENT_MOCK_RUNTIME_PATH = resolve("scripts/mock-provider-runtime.mjs");
}
for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY", "CLAUDE_API_KEY"])
  delete childEnvironment[name];
execFileSync(
  process.execPath,
  ["--import", "tsx", resolve("scripts/launch-consensus-acceptance-infrastructure.ts"), infrastructureRequestPath],
  { cwd: resolve("."), env: childEnvironment, stdio: "inherit" },
);
const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
const byId = new Map(inventory.resources.map((resource: { resourceId: string }) => [resource.resourceId, resource]));
childEnvironment.DISPOSABLE_ACCEPTANCE_PROVIDER_WRITABLE_ROOT_BINDINGS = JSON.stringify(
  inventory.resources
    .filter(
      (resource: { type: string; lifecycleState: string }) =>
        resource.type === "sandbox_root" && resource.lifecycleState === "verified",
    )
    .map(
      (resource: {
        resourceId: string;
        identity: {
          intendedPath: string;
          canonicalPath: string;
          filesystemAuthorityIdentity: string;
          rootPurpose: string;
        };
      }) => ({
        resourceId: resource.resourceId,
        acceptanceRunId: runId,
        rootPurpose: resource.identity.rootPurpose,
        intendedPath: resource.identity.intendedPath,
        canonicalPath: resource.identity.canonicalPath,
        filesystemAuthorityIdentity: resource.identity.filesystemAuthorityIdentity,
      }),
    ),
);
childEnvironment.CONSENSUS_ACCEPTANCE_SERVER_PID = String(
  (byId.get("mission-control-server") as { identity: { pid: number } }).identity.pid,
);
childEnvironment.CONSENSUS_ACCEPTANCE_DATABASE_PID = String(
  (byId.get("database-service") as { identity: { pid: number } }).identity.pid,
);
childEnvironment.CONSENSUS_ACCEPTANCE_INFRASTRUCTURE_INVENTORY_SHA256 = inventory.sha256;
execFileSync(
  "/bin/sh",
  [
    "-c",
    `attempt=0; until curl -fsS '${publicUrl}/api/health' >/dev/null; do attempt=$((attempt+1)); [ "$attempt" -lt 150 ] || exit 1; sleep 0.2; done`,
  ],
  { env: childEnvironment, stdio: "inherit" },
);
async function runHarnessWithRestart() {
  const focusedProviderRetry = process.env.CONSENSUS_FOCUSED_PROVIDER_RETRY === "true";
  const restartRequestPath = join(evidenceRoot, "mission-control-restart-request.json");
  const restartResponsePath = join(evidenceRoot, "mission-control-restart-response.json");
  childEnvironment.CONSENSUS_ACCEPTANCE_RESTART_REQUEST = restartRequestPath;
  childEnvironment.CONSENSUS_ACCEPTANCE_RESTART_RESPONSE = restartResponsePath;
  const harness = spawn(process.execPath, ["--import", "tsx", resolve("scripts/run-consensus-real-acceptance.ts")], {
    cwd: resolve("."),
    env: childEnvironment,
    stdio: "inherit",
  });
  if (!harness.pid) throw new Error("Mock acceptance harness did not expose a PID");
  let restartCoordinated = false;
  while (harness.exitCode === null && harness.signalCode === null) {
    if (!restartCoordinated && existsSync(restartRequestPath)) {
      execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          resolve("scripts/restart-consensus-acceptance-server.ts"),
          restartRequestPath,
          restartResponsePath,
        ],
        { cwd: resolve("."), env: childEnvironment, stdio: "inherit" },
      );
      restartCoordinated = true;
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  const terminal = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
    if (harness.exitCode !== null || harness.signalCode !== null)
      done({ code: harness.exitCode, signal: harness.signalCode });
    else harness.once("close", (code, signal) => done({ code, signal }));
  });
  if (terminal.code !== 0)
    throw new Error(`Mock acceptance harness failed: code=${terminal.code} signal=${terminal.signal}`);
  if (!restartCoordinated && !focusedProviderRetry)
    throw new Error("Mock acceptance completed without launcher-coordinated restart");
}

runHarnessWithRestart()
  .then(() => {
    if (process.env.CONSENSUS_FOCUSED_PROVIDER_RETRY !== "true") {
      execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          resolve("scripts/finalize-consensus-real-acceptance.ts"),
          join(root, "acceptance-evidence.json"),
          join(root, "independent-review.json"),
          join(root, "cleanup.json"),
          join(root, "final-acceptance.json"),
        ],
        { cwd: resolve("."), env: childEnvironment, stdio: "inherit" },
      );
      return;
    }
    const focusedEvidencePath = join(root, "focused-provider-retry-evidence.json");
    const focusedCleanupPath = join(root, "focused-provider-retry-cleanup.json");
    execFileSync(
      process.execPath,
      ["--import", "tsx", resolve("scripts/cleanup-consensus-acceptance.ts"), focusedEvidencePath, focusedCleanupPath],
      { cwd: resolve("."), env: childEnvironment, stdio: "inherit" },
    );
  })
  .catch(async (error) => {
    const latestInventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
    const managedProcessAlive = latestInventory.resources
      .filter((resource: { type: string }) =>
        ["database_process", "mission_control_server", "mission_agent_process", "provider_subprocess"].includes(
          resource.type,
        ),
      )
      .some((resource: { identity: { pid?: number } }) => {
        try {
          if (!resource.identity.pid) return false;
          process.kill(resource.identity.pid, 0);
          return true;
        } catch {
          return false;
        }
      });
    const listenerAlive = await fetch(`${publicUrl}/api/health`)
      .then(() => true)
      .catch(() => false);
    if (managedProcessAlive || listenerAlive) {
      const outerHarnessPath = join(root, "outer-terminal-failure-harness.json");
      const outerCleanupPath = join(root, "outer-terminal-failure-cleanup.json");
      const primaryOutcome = {
        status: "failed",
        classification: "mock_launcher_observed_harness_failure",
        message: error instanceof Error ? error.message : String(error),
        recordedAt: new Date().toISOString(),
      };
      writeFileSync(
        outerHarnessPath,
        `${JSON.stringify(
          {
            workspaceId: runId,
            candidateBindings: latestInventory.candidateBindings,
            evidenceIndex: { sha256: canonicalHash({ acceptanceRunId: runId, primaryOutcome }) },
            runResourceInventory: latestInventory,
            primaryOutcome,
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      execFileSync(
        process.execPath,
        ["--import", "tsx", resolve("scripts/cleanup-consensus-acceptance.ts"), outerHarnessPath, outerCleanupPath],
        { cwd: resolve("."), env: childEnvironment, stdio: "inherit" },
      );
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
