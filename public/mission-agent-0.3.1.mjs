#!/usr/bin/env node
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, join } from "node:path";

const VERSION = "0.3.1";
const root = process.env.MISSION_AGENT_HOME ?? join(homedir(), ".mission-agent");
const configPath = join(root, "config.json");
const statePath = join(root, "state.json");
const scriptPath = join(root, `mission-agent-${VERSION}.mjs`);
const binDirectory = process.env.MISSION_AGENT_BIN_DIR ?? join(homedir(), ".local", "bin");
const launcherPath = join(binDirectory, "mission-agent");
const command = process.argv[2] ?? "status";
const option = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const exec = (binary, args, cwd) => {
  const result = spawnSync(binary, args, { cwd, encoding: "utf8", timeout: 15_000 });
  if (result.status !== 0) {
    if (binary === "git" && result.error?.code === "ENOENT") {
      throw new Error("Git is not installed or is not available on PATH.");
    }
    if (binary === "git" && /not a git repository/i.test(result.stderr ?? "")) {
      throw new Error(
        "No Git repository was found. Run this command from inside a Git repository or provide --repository /absolute/path/to/repository.",
      );
    }
    throw new Error(`${binary} returned an error${result.stderr?.trim() ? `: ${result.stderr.trim()}` : "."}`);
  }
  return result.stdout.trim();
};

async function protectedJson(path) {
  const info = await stat(path);
  if ((info.mode & 0o077) !== 0) throw new Error(`Unsafe permissions on ${path}; expected 0600.`);
  return JSON.parse(await readFile(path, "utf8"));
}
async function save(path, value) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}
function keychainSecret(agentId) {
  const result = spawnSync("security", ["find-generic-password", "-a", agentId, "-s", "Mission Agent", "-w"], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error("Mission Agent credential is missing from macOS Keychain.");
  return result.stdout.trim();
}
async function loadConfig() {
  const config = await protectedJson(configPath);
  config.secret = config.secretStorage === "keychain" ? keychainSecret(config.agentId) : config.secret;
  if (!config.secret) throw new Error("Mission Agent credential is missing.");
  return config;
}
async function updateState(patch) {
  let current = {};
  try {
    current = await protectedJson(statePath);
  } catch {}
  await save(statePath, { ...current, ...patch, updatedAt: new Date().toISOString(), version: VERSION });
}

function envelope(config, messageType, payload, execution) {
  const messageId = randomUUID();
  return {
    protocolVersion: "1.0",
    messageId,
    idempotencyKey: `${messageType}:${messageId}`,
    agentId: config.agentId,
    workspaceId: config.workspaceId,
    sentAt: new Date().toISOString(),
    messageType,
    correlationId: execution?.missionId ?? config.agentId,
    ...(execution
      ? {
          missionId: execution.missionId,
          taskId: execution.taskId,
          executionId: execution.executionId,
          attempt: execution.attempt,
        }
      : {}),
    payload,
  };
}
async function signedRequest(config, path, messageType, payload = {}, execution, lease) {
  const message = envelope(config, messageType, payload, execution);
  const body = JSON.stringify(message);
  const checksum = sha256(body);
  const nonce = randomBytes(18).toString("base64url");
  const signingKey = sha256(config.secret);
  const signature = createHmac("sha256", signingKey)
    .update(["POST", path, message.sentAt, nonce, message.messageId, checksum, "1.0"].join("\n"))
    .digest("hex");
  const response = await fetch(`${config.missionControlUrl}${path}`, {
    method: "POST",
    signal: AbortSignal.timeout(messageType === "AgentAssignmentPullRequested" ? 25_000 : 15_000),
    headers: {
      "content-type": "application/json",
      "x-mc-agent-id": config.agentId,
      "x-mc-credential-id": config.credentialId,
      "x-mc-timestamp": message.sentAt,
      "x-mc-nonce": nonce,
      "x-mc-message-id": message.messageId,
      "x-mc-protocol-version": "1.0",
      "x-mc-body-sha256": checksum,
      "x-mc-signature": signature,
      ...(lease
        ? {
            "x-mc-assignment-id": lease.assignmentId,
            "x-mc-lease-owner": lease.leaseOwner,
            "x-mc-lease-token": lease.leaseToken,
          }
        : {}),
    },
    body,
  });
  if (response.status === 204) return undefined;
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message ?? `Mission Control returned ${response.status}.`);
  return result;
}

async function heartbeat(config) {
  await signedRequest(config, "/api/agent-protocol/v1/messages", "AgentHeartbeat", {
    status: "ready",
    assignmentPull: true,
    missionAgentVersion: VERSION,
    adapter: config.adapter,
    platform: platform(),
    capabilities: config.capabilities,
  });
  await updateState({ connected: true, pullReady: true, lastHeartbeatAt: new Date().toISOString(), lastError: null });
}
function inspectRepository(path) {
  if (!path) throw new Error("Provide a repository path, for example: mission-agent repository add .");
  const top = exec("git", ["rev-parse", "--show-toplevel"], path);
  const resolved = exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], path);
  if (top !== resolved) throw new Error("Repository path could not be resolved safely.");
  const commit = exec("git", ["rev-parse", "HEAD"], resolved);
  const branch = exec("git", ["branch", "--show-current"], resolved) || "detached";
  const remote = spawnSync("git", ["remote", "get-url", "origin"], { cwd: resolved, encoding: "utf8" });
  const remoteUrl = remote.status === 0 ? remote.stdout.trim().replace(/\/\/[^/@]+@/, "//[redacted]@") : undefined;
  return {
    path: resolved,
    name: basename(resolved),
    commit,
    branch,
    remoteUrl,
    fingerprint: sha256(`${remoteUrl ?? "local"}\n${commit}\n${basename(resolved)}`),
  };
}
function normalizedRemote(remoteUrl) {
  if (!remoteUrl) return "local repository";
  return remoteUrl
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/^https?:\/\/(?:[^/@]+@)?/, "")
    .replace(/^ssh:\/\/git@/, "")
    .replace(/\.git$/, "");
}
async function registerRepository(config, path) {
  const repository = inspectRepository(path);
  const response = await signedRequest(config, "/api/agent-protocol/v1/repositories", "AgentRepositoryRegistered", {
    name: repository.name,
    fingerprint: repository.fingerprint,
    defaultBranch: repository.branch,
    remoteUrl: repository.remoteUrl,
    commit: repository.commit,
  });
  const registered = response.repository;
  config.repositories = {
    ...(config.repositories ?? {}),
    [registered.repository_id]: {
      path: repository.path,
      fingerprint: repository.fingerprint,
      name: repository.name,
      remoteUrl: repository.remoteUrl,
      branch: repository.branch,
      commit: repository.commit,
    },
  };
  await persistConfig(config);
  return registered;
}
async function installLauncher() {
  await mkdir(binDirectory, { recursive: true, mode: 0o755 });
  await writeFile(launcherPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, { mode: 0o755 });
  await chmod(launcherPath, 0o755);
}
async function installCurrentVersion() {
  await loadConfig();
  await writeFile(scriptPath, await readFile(new URL(import.meta.url), "utf8"), { mode: 0o700 });
  await chmod(scriptPath, 0o700);
  await installLauncher();
  console.log(`Mission Agent ${VERSION} installed without changing credentials or repository registrations.`);
}
async function persistConfig(config) {
  const stored = { ...config };
  if (stored.secretStorage === "keychain") delete stored.secret;
  await save(configPath, stored);
}

async function installService() {
  const servicePath = process.env.PATH || "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  const xmlPath = servicePath.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  if (platform() === "darwin") {
    const directory = join(homedir(), "Library", "LaunchAgents");
    const plist = join(directory, "com.wallyweb.mission-agent.plist");
    await mkdir(directory, { recursive: true });
    await writeFile(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>com.wallyweb.mission-agent</string><key>ProgramArguments</key><array><string>${process.execPath}</string><string>${scriptPath}</string><string>run</string></array><key>EnvironmentVariables</key><dict><key>MISSION_AGENT_HOME</key><string>${root}</string><key>PATH</key><string>${xmlPath}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${join(root, "mission-agent.log")}</string><key>StandardErrorPath</key><string>${join(root, "mission-agent-error.log")}</string></dict></plist>\n`,
      { mode: 0o600 },
    );
    spawnSync("launchctl", ["bootout", `gui/${process.getuid()}`, plist], { stdio: "ignore" });
    const loaded = spawnSync("launchctl", ["bootstrap", `gui/${process.getuid()}`, plist], { stdio: "ignore" });
    return loaded.status === 0;
  }
  if (platform() === "linux" && spawnSync("systemctl", ["--user", "--version"], { stdio: "ignore" }).status === 0) {
    const directory = join(homedir(), ".config", "systemd", "user");
    const unit = join(directory, "mission-agent.service");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      unit,
      `[Unit]\nDescription=Mission Agent\nAfter=network-online.target\n\n[Service]\nExecStart=${process.execPath} ${scriptPath} run\nEnvironment=MISSION_AGENT_HOME=${root}\nEnvironment=PATH=${servicePath}\nRestart=on-failure\nRestartSec=5\nNoNewPrivileges=true\n\n[Install]\nWantedBy=default.target\n`,
      { mode: 0o600 },
    );
    const loaded = spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    const enabled = spawnSync("systemctl", ["--user", "enable", "--now", "mission-agent.service"], { stdio: "ignore" });
    return loaded.status === 0 && enabled.status === 0;
  }
  return false;
}

async function connect(encoded) {
  if (!encoded) throw new Error("Use the connection command generated by Mission Control.");
  const config = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  config.adapter =
    config.agentType === "claude_code"
      ? "claude-code"
      : config.agentType === "generic_remote"
        ? "generic"
        : config.agentType;
  config.leaseOwner = `${platform()}-${randomUUID()}`;
  config.repositories = {};
  if (
    platform() === "darwin" &&
    process.env.MISSION_AGENT_SECRET_STORE !== "file" &&
    spawnSync("security", ["help"], { stdio: "ignore" }).status === 0
  ) {
    const result = spawnSync(
      "security",
      ["add-generic-password", "-a", config.agentId, "-s", "Mission Agent", "-w", config.secret, "-U"],
      { stdio: "ignore" },
    );
    if (result.status !== 0) throw new Error("Could not store the credential in macOS Keychain.");
    config.secretStorage = "keychain";
  } else config.secretStorage = "file-0600";
  await persistConfig(config);
  await registerRepository(config, option("--repository") ?? process.cwd());
  await heartbeat(config);
  await writeFile(scriptPath, await readFile(new URL(import.meta.url), "utf8"), { mode: 0o700 });
  await chmod(scriptPath, 0o700);
  await installLauncher();
  if (!process.argv.includes("--no-start")) {
    const serviceStarted = await installService().catch(() => false);
    if (!serviceStarted) {
      const child = spawn(process.execPath, [scriptPath, "run"], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, MISSION_AGENT_HOME: root },
      });
      child.unref();
    }
  }
  console.log(
    `\nMission Agent connected.\n\nAgent: ${config.agentName}\nWorkspace: ${config.workspaceName}\nMission Control: ${config.missionControlUrl}\nHeartbeat: received\nAssignment polling: active\nRepositories: ${Object.keys(config.repositories).length}\n\nYour Mission Agent can manage multiple repositories from this computer.\nAdd another with: mission-agent repository add /path/to/repository\n${process.env.PATH?.split(":").includes(binDirectory) ? "" : `\nAdd ${binDirectory} to PATH to use the stable mission-agent command.\n`}`,
  );
}

async function protocolMessage(config, assignment, type, payload) {
  return signedRequest(config, "/api/agent-protocol/v1/messages", type, payload, assignment, assignment);
}
async function assignmentAction(config, assignment, action, type) {
  const path = `/api/agent-protocol/v1/assignments/${assignment.assignmentId}/${action}`;
  return signedRequest(
    config,
    path,
    type,
    { leaseOwner: assignment.leaseOwner, leaseToken: assignment.leaseToken },
    assignment,
    assignment,
  );
}
async function progress(config, assignment, stage, summary, percent) {
  await protocolMessage(config, assignment, "ExecutionProgressReported", { stage, summary, progressPercent: percent });
  await updateState({ activeAssignment: assignment, stage, leaseExpiresAt: assignment.leaseExpiresAt });
}
async function executeAnalysis(config, assignment) {
  if (config.adapter !== "codex")
    throw new Error(`The ${config.adapter} adapter can connect but cannot execute local tasks yet.`);
  const resource = assignment.allowedResources?.find((item) => item.resourceType === "repository");
  const repository = resource ? config.repositories?.[resource.resourceId] : undefined;
  if (!repository) throw new Error("The assignment repository is not registered on this Mission Agent.");
  const resolved = await realpath(repository.path);
  if (resolved !== repository.path) throw new Error("Repository path changed after registration.");
  await progress(config, assignment, "validating_repository", "Validating repository", 10);
  const before = exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], resolved);
  const beforeCommit = exec("git", ["rev-parse", "HEAD"], resolved);
  const outputPath = join(root, `artifact-${assignment.executionId}.md`);
  const prompt = `Analyze this repository in read-only mode. Do not modify files, install packages, commit, push, create pull requests, access secrets, or deploy. Produce Markdown with exactly these sections: Repository overview, Main technologies, Application structure, Important commands, Test setup, Notable risks, Suggested next mission. Base every finding on visible repository contents. Objective: ${assignment.instructions ?? assignment.taskObjective}`;
  await progress(config, assignment, "inspecting_repository", "Inspecting repository structure", 25);
  const child = spawn("codex", ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "-o", outputPath, prompt], {
    cwd: resolved,
    env: Object.fromEntries(
      ["PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"].flatMap((name) =>
        process.env[name] ? [[name, process.env[name]]] : [],
      ),
    ),
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  let cancellationRequested = false;
  child.stderr.on("data", (chunk) => (stderr += String(chunk).slice(-4000)));
  const renew = setInterval(
    () =>
      void assignmentAction(config, assignment, "lease", "AgentAssignmentLeaseRenewed").catch(() =>
        child.kill("SIGTERM"),
      ),
    25_000,
  );
  const cancel = setInterval(async () => {
    const result = await assignmentAction(
      config,
      assignment,
      "cancellation",
      "AgentAssignmentCancellationChecked",
    ).catch(() => undefined);
    if (result?.cancellationRequested) {
      cancellationRequested = true;
      child.kill("SIGTERM");
    }
  }, 10_000);
  let exitCode;
  try {
    exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } catch (error) {
    if (error?.code === "ENOENT")
      throw new Error("Codex could not be started by the background service. Run mission-agent doctor, then mission-agent service install.");
    throw error;
  } finally {
    clearInterval(renew);
    clearInterval(cancel);
  }
  if (cancellationRequested) {
    await protocolMessage(config, assignment, "ExecutionCancellationAcknowledged", {
      summary: "Mission Agent stopped the local adapter after cancellation was requested.",
    });
    await assignmentAction(config, assignment, "release", "AgentAssignmentReleased").catch(() => undefined);
    await updateState({ activeAssignment: null, stage: "cancelled", lastError: null });
    return;
  }
  if (exitCode !== 0) throw new Error(`Codex analysis failed${stderr ? ": " + stderr.slice(-300) : "."}`);
  await progress(config, assignment, "preparing_findings", "Preparing findings", 75);
  const after = exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], resolved);
  const afterCommit = exec("git", ["rev-parse", "HEAD"], resolved);
  if (before !== after || beforeCommit !== afterCommit)
    throw new Error("Read-only verification detected a repository change.");
  const report = await readFile(outputPath);
  if (!report.length || report.length > 128 * 1024)
    throw new Error("Repository analysis artifact is empty or oversized.");
  await progress(config, assignment, "uploading_report", "Uploading repository analysis", 90);
  await protocolMessage(config, assignment, "ExecutionArtifactSubmitted", {
    name: "Repository analysis",
    description: "Read-only analysis produced by the local Codex adapter",
    artifactType: "repository_analysis",
    mediaType: "text/markdown",
    byteSize: report.length,
    checksum: sha256(report),
    contentBase64: report.toString("base64"),
    repositoryCommit: beforeCommit,
  });
  await protocolMessage(config, assignment, "ExecutionSucceeded", {
    summary: "Read-only repository analysis completed and verified without repository changes.",
    usage: { runtime: `mission-agent/${VERSION}`, durationMs: 0 },
  });
  await updateState({ activeAssignment: null, stage: "completed", lastCompletedExecution: assignment.executionId });
  await rm(outputPath, { force: true });
}
async function uploadArtifact(config, assignment, input) {
  const body = Buffer.isBuffer(input.body) ? input.body : Buffer.from(input.body);
  if (!body.length || body.length > 2 * 1024 * 1024) throw new Error(`${input.name} artifact is empty or oversized.`);
  const chunkSize = 120 * 1024;
  const chunks = Math.ceil(body.length / chunkSize);
  let first;
  for (let index = 0; index < chunks; index += 1) {
    const chunk = body.subarray(index * chunkSize, Math.min(body.length, (index + 1) * chunkSize));
    const response = await protocolMessage(config, assignment, "ExecutionArtifactSubmitted", {
      name: chunks === 1 ? input.name : `${input.name} (${index + 1}/${chunks})`,
      description: chunks === 1 ? input.description : `${input.description}; byte-preserving part ${index + 1} of ${chunks}`,
      artifactType: input.type,
      mediaType: input.mediaType,
      byteSize: chunk.length,
      checksum: sha256(chunk),
      contentBase64: chunk.toString("base64"),
      repositoryCommit: input.repositoryCommit,
      partNumber: index + 1,
      partCount: chunks,
      completeChecksum: sha256(body),
    });
    first ??= response;
  }
  return first;
}
async function runCodex(config, assignment, args, cwd) {
  const child = spawn("codex", args, {
    cwd,
    env: Object.fromEntries(
      ["PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"].flatMap((name) =>
        process.env[name] ? [[name, process.env[name]]] : [],
      ),
    ),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => (stdout = (stdout + String(chunk)).slice(-512_000)));
  child.stderr.on("data", (chunk) => (stderr = (stderr + String(chunk)).slice(-512_000)));
  const renew = setInterval(
    () => void assignmentAction(config, assignment, "lease", "AgentAssignmentLeaseRenewed").catch(() => child.kill("SIGTERM")),
    25_000,
  );
  let exitCode;
  try {
    exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } catch (error) {
    if (error?.code === "ENOENT")
      throw new Error("Codex could not be started by the background service. Run mission-agent doctor.");
    throw error;
  } finally {
    clearInterval(renew);
  }
  return { exitCode, stdout, stderr };
}
function safeValidationCommands(value) {
  const allowed = new Set(["npm", "pnpm", "yarn", "bun", "npx", "node"]);
  if (!Array.isArray(value) || value.length > 10) throw new Error("Validation command configuration is invalid.");
  return value.map((command) => {
    if (!Array.isArray(command) || !command.length || !allowed.has(command[0]))
      throw new Error("A validation command is not allowed.");
    if (command.some((part) => typeof part !== "string" || !/^[A-Za-z0-9_./:@=,+-]+$/.test(part) || part.includes("..")))
      throw new Error("A validation command contains unsafe arguments.");
    return command;
  });
}
async function executeChange(config, assignment) {
  if (config.adapter !== "codex") throw new Error("Repository changes currently require the Codex adapter.");
  const resource = assignment.allowedResources?.find((item) => item.resourceType === "repository");
  const repository = resource ? config.repositories?.[resource.resourceId] : undefined;
  if (!repository) throw new Error("The assignment repository is not registered on this Mission Agent.");
  const resolved = await realpath(repository.path);
  if (resolved !== repository.path) throw new Error("Repository path changed after registration.");
  const originalStatus = exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], resolved);
  if (originalStatus) throw new Error("The registered repository has uncommitted changes. Commit or stash them before a change mission.");
  const baseBranch = repository.branch;
  const baseCommit = exec("git", ["rev-parse", `${baseBranch}^{commit}`], resolved);
  const planPath = join(root, `plan-${assignment.executionId}.md`);
  await progress(config, assignment, "planning_change", "Codex is preparing an implementation plan", 10);
  const planPrompt = `Inspect this repository in read-only mode and prepare an implementation plan for: ${assignment.instructions}. Do not modify files. Produce Markdown with exactly these sections: Likely files or components, Expected behavior, Tests to add or update, Risks, Validation approach.`;
  const planResult = await runCodex(
    config,
    assignment,
    ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "-o", planPath, planPrompt],
    resolved,
  );
  if (planResult.exitCode !== 0) throw new Error(`Codex planning failed${planResult.stderr ? ": " + planResult.stderr.slice(-300) : "."}`);
  if (exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], resolved) !== originalStatus)
    throw new Error("Planning changed the registered repository; write approval was not granted.");
  const plan = await readFile(planPath);
  const uploadedPlan = await uploadArtifact(config, assignment, {
    name: "Implementation plan",
    description: "Read-only Codex plan produced before write approval",
    type: "implementation_plan",
    mediaType: "text/markdown",
    body: plan,
    repositoryCommit: baseCommit,
  });
  await progress(config, assignment, "waiting_for_write_approval", "Implementation plan ready for human approval", 20);
  let approval = await assignmentAction(config, assignment, "approval", "AgentApprovalStatusChecked");
  if (approval.status === "not_requested") {
    const requested = await protocolMessage(config, assignment, "ExecutionApprovalRequested", {
      actionType: "repository.modify",
      parameters: { repositoryId: resource.resourceId, baseBranch, baseCommit, objective: assignment.instructions },
      targetResource: `repository:${resource.resourceId}`,
      riskExplanation: "Codex requests permission to modify files and create one local commit in an isolated worktree.",
      evidence: [{ artifactId: uploadedPlan.artifactId, checksum: sha256(plan), kind: "implementation_plan" }],
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    if (requested.status !== "approval_required") throw new Error("Mission Control did not create the required write approval.");
    approval = { status: "pending", approvalId: requested.approvalId };
  }
  while (!approval || approval.status === "pending") {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await assignmentAction(config, assignment, "lease", "AgentAssignmentLeaseRenewed");
    approval = await assignmentAction(config, assignment, "approval", "AgentApprovalStatusChecked");
    const cancellation = await assignmentAction(
      config,
      assignment,
      "cancellation",
      "AgentAssignmentCancellationChecked",
    );
    if (cancellation.cancellationRequested) throw new Error("Repository change was cancelled while awaiting approval.");
  }
  if (approval.status !== "granted") throw new Error(`Repository write approval was ${approval.status}.`);
  await protocolMessage(config, assignment, "ExecutionResumed", {
    stage: "write_approved",
    summary: "Human approved isolated repository modifications",
    approvalId: approval.approvalId,
    actionHash: approval.actionHash,
  });
  const worktreeRoot = join(root, "worktrees");
  const worktreePath = join(worktreeRoot, assignment.executionId);
  await mkdir(worktreeRoot, { recursive: true, mode: 0o700 });
  const slug = String(assignment.taskObjective ?? "change").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "change";
  const branchName = `mission/${assignment.missionId.slice(0, 8)}-${slug}`;
  let worktreeExists = false;
  try {
    worktreeExists = (await stat(join(worktreePath, ".git"))).isFile();
  } catch {}
  if (!worktreeExists) {
    const branchExists = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], { cwd: resolved }).status === 0;
    const created = spawnSync(
      "git",
      branchExists
        ? ["worktree", "add", worktreePath, branchName]
        : ["worktree", "add", "-b", branchName, worktreePath, baseCommit],
      { cwd: resolved, encoding: "utf8", timeout: 60_000 },
    );
    if (created.status !== 0) throw new Error(`Safe worktree isolation could not be established: ${created.stderr?.trim() ?? "git failed"}`);
  }
  if (exec("git", ["rev-parse", `${baseBranch}^{commit}`], resolved) !== baseCommit)
    throw new Error("The source branch moved after approval; start a new change mission from the latest commit.");
  const recoveredCommit = exec("git", ["rev-parse", "HEAD"], worktreePath);
  if (recoveredCommit !== baseCommit && !exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], worktreePath)) {
    const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", baseCommit, recoveredCommit], { cwd: worktreePath });
    if (ancestry.status !== 0) throw new Error("Recovered worktree is not based on the approved commit.");
    const recoveredFiles = exec("git", ["diff", "--name-status", `${baseCommit}..${recoveredCommit}`], worktreePath);
    const recoveredPatch = spawnSync("git", ["diff", "--binary", `${baseCommit}..${recoveredCommit}`], { cwd: worktreePath, encoding: "utf8", timeout: 60_000 });
    if (!recoveredFiles || recoveredPatch.status !== 0) throw new Error("Recovered local commit has no reviewable diff evidence.");
    await uploadArtifact(config, assignment, { name: "Recovered repository diff", description: "Full diff recovered from the existing local mission commit", type: "git_patch", mediaType: "text/x-diff", body: recoveredPatch.stdout, repositoryCommit: recoveredCommit });
    await uploadArtifact(config, assignment, { name: "Recovered change summary", description: "Restart recovery evidence for the existing local commit", type: "change_summary", mediaType: "text/markdown", body: `Mission Agent recovered an already-created local commit after restart.\n\nBase branch: ${baseBranch}\nBase commit: ${baseCommit}\nLocal branch: ${branchName}\nLocal commit: ${recoveredCommit}\n\nChanged files:\n${recoveredFiles}`, repositoryCommit: recoveredCommit });
    await protocolMessage(config, assignment, "ExecutionSucceeded", {
      summary: "Recovered the approved isolated repository change and its existing local commit after restart.",
      stage: "completed",
      branchName,
      baseBranch,
      baseCommit,
      commitId: recoveredCommit,
      validationStatus: "recovered_after_validated_commit",
      usage: { runtime: `mission-agent/${VERSION}`, durationMs: 0 },
    });
    await updateState({ activeAssignment: null, stage: "completed", lastCompletedExecution: assignment.executionId, reviewWorktree: worktreePath });
    await rm(planPath, { force: true });
    return;
  }
  await progress(config, assignment, "worktree_ready", "Isolated mission branch and worktree created", 30);
  const summaryPath = join(root, `change-summary-${assignment.executionId}.md`);
  const changePrompt = `Implement this approved repository change inside the current isolated worktree: ${assignment.instructions}\n\nFollow the approved plan:\n${plan.toString("utf8")}\n\nDo not push, create a pull request, merge, deploy, access secrets, modify infrastructure, or write outside this worktree. Do not commit; Mission Agent will validate and create the local commit. Return a concise factual summary.`;
  const changeResult = await runCodex(
    config,
    assignment,
    ["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check", "-o", summaryPath, changePrompt],
    worktreePath,
  );
  await uploadArtifact(config, assignment, {
    name: "Codex execution log",
    description: "Structured local Codex execution output",
    type: "codex_execution_log",
    mediaType: "application/jsonl",
    body: `${changeResult.stdout}\n${changeResult.stderr}`,
    repositoryCommit: baseCommit,
  });
  if (changeResult.exitCode !== 0) throw new Error(`Codex change execution failed${changeResult.stderr ? ": " + changeResult.stderr.slice(-300) : "."}`);
  await progress(config, assignment, "validating_change", "Running approved validation commands", 65);
  const validationResults = [];
  for (const command of safeValidationCommands(assignment.validationCommands ?? [])) {
    const result = spawnSync(command[0], command.slice(1), {
      cwd: worktreePath,
      encoding: "utf8",
      timeout: 300_000,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", LANG: process.env.LANG ?? "" },
    });
    validationResults.push(`$ ${command.join(" ")}\nexit=${result.status}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    if (result.status !== 0) {
      await uploadArtifact(config, assignment, { name: "Validation results", description: "Approved repository-local validation commands", type: "validation_results", mediaType: "text/plain", body: validationResults.join("\n\n"), repositoryCommit: baseCommit });
      throw new Error(`Validation failed: ${command.join(" ")}`);
    }
  }
  const changedFiles = exec("git", ["status", "--short"], worktreePath);
  if (!changedFiles) throw new Error("Codex produced no repository changes.");
  const patch = spawnSync("git", ["diff", "--binary", "HEAD"], { cwd: worktreePath, encoding: "utf8", timeout: 60_000 });
  if (patch.status !== 0) throw new Error("Git diff evidence could not be collected.");
  await uploadArtifact(config, assignment, { name: "Repository diff", description: "Full diff before local commit", type: "git_patch", mediaType: "text/x-diff", body: patch.stdout, repositoryCommit: baseCommit });
  await uploadArtifact(config, assignment, { name: "Validation results", description: "Approved repository-local validation commands", type: "validation_results", mediaType: "text/plain", body: validationResults.length ? validationResults.join("\n\n") : "No explicit validation commands were supplied. Codex self-validation is recorded in the execution log.", repositoryCommit: baseCommit });
  exec("git", ["add", "--all"], worktreePath);
  const committed = spawnSync("git", ["-c", "user.name=Mission Control Codex", "-c", "user.email=codex@localhost", "commit", "-m", `mission: complete ${assignment.executionId}`], { cwd: worktreePath, encoding: "utf8", timeout: 60_000 });
  if (committed.status !== 0) throw new Error(`Local commit failed: ${committed.stderr?.trim() ?? "git failed"}`);
  const commitId = exec("git", ["rev-parse", "HEAD"], worktreePath);
  if (exec("git", ["rev-parse", `${baseBranch}^{commit}`], resolved) !== baseCommit || exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], resolved) !== originalStatus)
    throw new Error("Safety verification detected a change to the original branch or worktree.");
  const summary = await readFile(summaryPath).catch(() => Buffer.from("Codex completed the approved repository change."));
  await uploadArtifact(config, assignment, { name: "Change summary", description: "Review summary with branch and commit evidence", type: "change_summary", mediaType: "text/markdown", body: `${summary.toString("utf8")}\n\nBase branch: ${baseBranch}\nBase commit: ${baseCommit}\nLocal branch: ${branchName}\nLocal commit: ${commitId}\n\nChanged files:\n${changedFiles}`, repositoryCommit: commitId });
  await progress(config, assignment, "review_ready", "Local commit and review evidence are ready", 95);
  await protocolMessage(config, assignment, "ExecutionSucceeded", {
    summary: "Approved repository change completed in an isolated worktree with local commit evidence.",
    stage: "completed",
    branchName,
    baseBranch,
    baseCommit,
    commitId,
    validationStatus: validationResults.length ? "validated" : "partially_validated",
    usage: { runtime: `mission-agent/${VERSION}`, durationMs: 0 },
  });
  await updateState({ activeAssignment: null, stage: "completed", lastCompletedExecution: assignment.executionId, reviewWorktree: worktreePath });
  await rm(planPath, { force: true });
  await rm(summaryPath, { force: true });
}
async function work(config, assignment) {
  if (!assignment.leaseToken) throw new Error("Mission Agent cannot resume because its local lease token is missing.");
  await updateState({
    activeAssignment: assignment,
    stage: "assignment_received",
    leaseExpiresAt: assignment.leaseExpiresAt,
  });
  await assignmentAction(config, assignment, "acknowledge", "AgentAssignmentAcknowledged");
  try {
    if (assignment.missionType === "repository_change") await executeChange(config, assignment);
    else await executeAnalysis(config, assignment);
  } catch (error) {
    await protocolMessage(config, assignment, "ExecutionFailed", {
      classification: "local_adapter_failure",
      summary: error.message,
    }).catch(() => undefined);
    await updateState({ activeAssignment: null, stage: "failed", lastError: error.message });
  }
}
async function run() {
  const config = await loadConfig();
  await heartbeat(config);
  const heartbeatTimer = setInterval(
    () =>
      void heartbeat(config).catch((error) =>
        updateState({ connected: false, lastError: `Heartbeat failed: ${error.message}` }),
      ),
    60_000,
  );
  heartbeatTimer.unref();
  let recovered;
  try {
    const state = await protectedJson(statePath);
    recovered =
      state.activeAssignment && typeof state.activeAssignment === "object" ? state.activeAssignment : undefined;
  } catch {}
  if (recovered) {
    try {
      const renewed = await assignmentAction(config, recovered, "lease", "AgentAssignmentLeaseRenewed");
      recovered.leaseExpiresAt = renewed.leaseExpiresAt;
      await work(config, recovered);
      if (process.argv.includes("--once")) return;
    } catch {
      await updateState({
        activeAssignment: null,
        stage: "recovering",
        lastError: "Prior lease could not be recovered",
      });
    }
  }
  for (;;) {
    try {
      const response = await signedRequest(
        config,
        "/api/agent-protocol/v1/assignments/pull",
        "AgentAssignmentPullRequested",
        { leaseOwner: config.leaseOwner, waitSeconds: 20 },
      );
      if (response?.assignment) {
        await work(config, response.assignment);
        if (process.argv.includes("--once")) return;
      } else if (process.argv.includes("--once")) return;
      else await new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 1000));
    } catch (error) {
      await updateState({ connected: false, lastError: error.message });
      if (process.argv.includes("--once")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5000 + Math.random() * 5000));
    }
  }
}
async function status() {
  const config = await loadConfig();
  let state = {};
  try {
    state = await protectedJson(statePath);
  } catch {}
  console.log(
    `Mission Control: ${config.missionControlUrl}\nAgent: ${config.agentName}\nAdapter: ${config.adapter}\nConnected: ${state.connected ? "yes" : "no"}\nLast heartbeat: ${state.lastHeartbeatAt ?? "never"}\nPolling: ${state.pullReady ? "active" : "inactive"}\nActive assignment: ${state.activeAssignment?.assignmentId ?? state.activeAssignment ?? "none"}\nLease expiration: ${state.leaseExpiresAt ?? "none"}\nStage: ${state.stage ?? "idle"}\nLast error: ${state.lastError ?? "none"}\nVersion: ${VERSION}`,
  );
}
async function doctor() {
  const checks = [];
  checks.push([Number(process.versions.node.split(".")[0]) >= 22, `Node ${process.version}`]);
  let config;
  try {
    config = await loadConfig();
    checks.push([true, "Protected configuration"]);
  } catch (error) {
    checks.push([false, error.message]);
  }
  checks.push([spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0, "Git executable"]);
  checks.push([spawnSync("codex", ["--version"], { stdio: "ignore" }).status === 0, "Codex executable"]);
  if (config) {
    try {
      await heartbeat(config);
      checks.push([true, "Mission Control signature and heartbeat"]);
    } catch (error) {
      checks.push([false, `Mission Control: ${error.message}`]);
    }
    for (const repository of Object.values(config.repositories ?? {})) {
      try {
        inspectRepository(repository.path);
        checks.push([true, `Repository ${repository.name}`]);
      } catch (error) {
        checks.push([false, `Repository: ${error.message}`]);
      }
    }
  }
  for (const [ok, label] of checks) console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (checks.some(([ok]) => !ok)) process.exitCode = 1;
}
async function logout() {
  if (!process.argv.includes("--yes"))
    throw new Error("Run mission-agent logout --yes to remove this local credential.");
  let config;
  try {
    config = await protectedJson(configPath);
  } catch {}
  if (config?.secretStorage === "keychain")
    spawnSync("security", ["delete-generic-password", "-a", config.agentId, "-s", "Mission Agent"], {
      stdio: "ignore",
    });
  await rm(root, { recursive: true, force: true });
  console.log("Mission Agent local credentials removed.");
}

async function repositoryList() {
  const config = await loadConfig();
  const entries = Object.entries(config.repositories ?? {});
  if (!entries.length) return console.log("No repositories registered.");
  for (const [id, repository] of entries)
    console.log(
      `${id}\t${repository.name}\t${normalizedRemote(repository.remoteUrl)}\t${repository.branch ?? "unknown"}`,
    );
}
async function repositoryInspect(id) {
  const config = await loadConfig();
  const repository = config.repositories?.[id];
  if (!repository) throw new Error(`Repository ${id ?? ""} is not registered on this Mission Agent.`);
  const current = inspectRepository(repository.path);
  console.log(
    `Repository: ${id}\nName: ${current.name}\nRemote: ${normalizedRemote(current.remoteUrl)}\nBranch: ${current.branch}\nCommit: ${current.commit}\nAgent: ${config.agentName}`,
  );
}
async function repositoryAdd(path) {
  const config = await loadConfig();
  const current = inspectRepository(path);
  await registerRepository(config, path);
  console.log(
    `Repository registered.\n\nName: ${current.name}\nRemote: ${normalizedRemote(current.remoteUrl)}\nBranch: ${current.branch}\nAgent: ${config.agentName}\n\nThis repository is now available when launching a mission.`,
  );
}
async function repositoryRemove(id) {
  const config = await loadConfig();
  if (!config.repositories?.[id]) throw new Error(`Repository ${id ?? ""} is not registered on this Mission Agent.`);
  await signedRequest(config, "/api/agent-protocol/v1/repositories/remove", "AgentRepositoryRemoved", {
    repositoryId: id,
  });
  delete config.repositories[id];
  await persistConfig(config);
  console.log(`Repository association removed.\n\nRepository: ${id}\nAgent: ${config.agentName}`);
}
async function update() {
  const config = await loadConfig();
  const response = await fetch(`${config.missionControlUrl}/mission-agent-latest.json`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Update manifest returned ${response.status}.`);
  const manifest = await response.json();
  if (manifest.version === VERSION) return console.log(`Mission Agent ${VERSION} is current.`);
  const artifact = await fetch(`${config.missionControlUrl}${manifest.path}`, { signal: AbortSignal.timeout(30_000) });
  if (!artifact.ok) throw new Error(`Update artifact returned ${artifact.status}.`);
  const source = await artifact.text();
  if (sha256(source) !== manifest.sha256) throw new Error("Update checksum verification failed.");
  const target = join(root, `mission-agent-${manifest.version}.mjs`);
  await writeFile(target, source, { mode: 0o700 });
  await mkdir(binDirectory, { recursive: true, mode: 0o755 });
  await writeFile(launcherPath, `#!/bin/sh\nexec "${process.execPath}" "${target}" "$@"\n`, { mode: 0o755 });
  console.log(`Mission Agent updated to ${manifest.version}. Run mission-agent service install to activate it there.`);
}

try {
  if (command === "connect") await connect(process.argv[3]);
  else if (command === "run") await run();
  else if (command === "status") await status();
  else if (command === "doctor") await doctor();
  else if (command === "logout") await logout();
  else if (command === "repository" && process.argv[3] === "list") await repositoryList();
  else if (command === "repository" && process.argv[3] === "add") await repositoryAdd(process.argv[4]);
  else if (command === "repository" && process.argv[3] === "remove") await repositoryRemove(process.argv[4]);
  else if (command === "repository" && process.argv[3] === "inspect") await repositoryInspect(process.argv[4]);
  else if (command === "install") await installCurrentVersion();
  else if (command === "update") await update();
  else if (command === "service" && process.argv[3] === "install") {
    if (!(await installService())) throw new Error("Automatic service installation is unavailable on this system.");
    console.log("Mission Agent service installed and started.");
  } else
    throw new Error(
      "Commands: connect, install, run, status, doctor, update, logout, repository list|add|remove|inspect",
    );
} catch (error) {
  console.error(
    `Mission Agent: ${error instanceof Error ? error.message.replace(/mc_agent_[A-Za-z0-9_-]+/g, "[redacted]") : "Unknown error"}`,
  );
  process.exitCode = 1;
}
