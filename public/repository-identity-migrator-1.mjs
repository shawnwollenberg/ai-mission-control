#!/usr/bin/env node
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.MISSION_AGENT_HOME ?? join(homedir(), ".mission-agent");
const configPath = join(root, "config.json");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const option = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

async function protectedJson(path) {
  const info = await stat(path);
  if ((info.mode & 0o077) !== 0) throw new Error(`Unsafe permissions on ${path}; expected 0600.`);
  return JSON.parse(await readFile(path, "utf8"));
}

async function saveConfig(value) {
  const temporary = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  const stored = { ...value };
  if (stored.secretStorage === "keychain") delete stored.secret;
  await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, configPath);
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

function execGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 15_000 });
  if (result.status !== 0)
    throw new Error(`Git identity inspection failed: ${result.stderr?.trim() || "unknown error"}`);
  return result.stdout.trim();
}

export function canonicalizeRepositoryRemote(value) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("A Git remote URL is required.");
  let host;
  let pathname;
  const scp = raw.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
  if (scp && !raw.includes("://")) {
    host = scp[1];
    pathname = scp[2];
  } else {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error("The Git remote URL is not canonicalizable.");
    }
    if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol))
      throw new Error("The Git remote protocol is unsupported.");
    const defaults = { "http:": "80", "https:": "443", "ssh:": "22", "git:": "9418" };
    host = `${parsed.hostname}${parsed.port && parsed.port !== defaults[parsed.protocol] ? `:${parsed.port}` : ""}`;
    pathname = parsed.pathname;
  }
  const cleanPath = pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  if (!host || !cleanPath || cleanPath.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error("The Git remote identity is ambiguous.");
  return `${host.toLowerCase()}/${cleanPath.normalize("NFC")}`;
}

export function deriveStableRepositoryIdentity(remotes, repositoryName) {
  const origin = remotes.filter((remote) => remote.name === "origin");
  const selected =
    origin.length === 1 ? origin[0] : origin.length === 0 && remotes.length === 1 ? remotes[0] : undefined;
  if (!selected)
    throw new Error(
      remotes.length ? "Repository remotes are ambiguous." : "Local-only repositories are not migration eligible.",
    );
  const canonicalRemoteUrl = canonicalizeRepositoryRemote(selected.url);
  const name = String(repositoryName ?? "")
    .trim()
    .normalize("NFC");
  if (!name || canonicalRemoteUrl.slice(canonicalRemoteUrl.lastIndexOf("/") + 1) !== name)
    throw new Error("Repository name does not exactly match the selected canonical remote.");
  return {
    identityVersion: "stable-v2",
    selectedRemote: selected.name,
    canonicalRemoteUrl,
    repositoryName: name,
    fingerprint: sha256(`${canonicalRemoteUrl}\n${name}`),
  };
}

function inspectRepository(path) {
  const resolved = execGit(["rev-parse", "--path-format=absolute", "--show-toplevel"], path);
  const commit = execGit(["rev-parse", "HEAD"], resolved);
  const names = execGit(["remote"], resolved).split(/\r?\n/).filter(Boolean);
  const remotes = names.map((name) => ({ name, url: execGit(["remote", "get-url", name], resolved) }));
  const name = basename(resolved);
  return { path: resolved, commit, name, remotes, stable: deriveStableRepositoryIdentity(remotes, name) };
}

async function signedRequest(config, path, messageType, payload) {
  const messageId = randomUUID();
  const sentAt = new Date().toISOString();
  const message = {
    protocolVersion: "1.0",
    messageId,
    idempotencyKey: `${messageType}:${messageId}`,
    agentId: config.agentId,
    workspaceId: config.workspaceId,
    sentAt,
    messageType,
    correlationId: config.agentId,
    payload,
  };
  const body = JSON.stringify(message);
  const checksum = sha256(body);
  const nonce = randomBytes(18).toString("base64url");
  const signature = createHmac("sha256", sha256(config.secret))
    .update(["POST", path, sentAt, nonce, messageId, checksum, "1.0"].join("\n"))
    .digest("hex");
  const response = await fetch(`${config.missionControlUrl}${path}`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: {
      "content-type": "application/json",
      "x-mc-agent-id": config.agentId,
      "x-mc-credential-id": config.credentialId,
      "x-mc-timestamp": sentAt,
      "x-mc-nonce": nonce,
      "x-mc-message-id": messageId,
      "x-mc-protocol-version": "1.0",
      "x-mc-body-sha256": checksum,
      "x-mc-signature": signature,
    },
    body,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message ?? `Mission Control returned ${response.status}.`);
  return result;
}

async function preview(repositoryId) {
  const config = await loadConfig();
  const registered = config.repositories?.[repositoryId];
  if (!registered) throw new Error(`Repository ${repositoryId ?? ""} is not registered on this Mission Agent.`);
  const current = inspectRepository(registered.path);
  const response = await signedRequest(
    config,
    "/api/agent-protocol/v1/repositories/identity/preview",
    "RepositoryIdentityMigrationPreviewed",
    {
      repositoryId,
      registeredPath: registered.path,
      currentHead: current.commit,
      repositoryName: current.name,
      legacyFingerprint: registered.fingerprint,
      migrationToolVersion: "1",
      remotes: current.remotes,
    },
  );
  const migration = response.preview;
  config.repositoryIdentityMigrations = {
    ...(config.repositoryIdentityMigrations ?? {}),
    [repositoryId]: {
      migrationId: migration.migrationId,
      requestFingerprint: migration.requestFingerprint,
      stableFingerprint: migration.stableFingerprint,
      registeredPath: registered.path,
      currentHead: current.commit,
      expiresAt: migration.expiresAt,
    },
  };
  await saveConfig(config);
  if (process.argv.includes("--json")) return console.log(JSON.stringify(migration));
  console.log(
    `Repository identity migration preview\n\nRepository: ${migration.repositoryId}\nAgent: ${migration.agentId}\nExisting: ${migration.legacyFingerprint} (legacy-v1)\nProposed: ${migration.stableFingerprint} (stable-v2)\nRemote: ${migration.canonicalRemoteUrl}\nName: ${migration.repositoryName}\nPath: ${migration.registeredPath}\nHEAD: ${migration.currentHead}\nProject Brain: ${migration.projectBrainEnabled ? "enabled" : "disabled"}\nSafe: ${migration.safe ? "yes" : "no"}\nApproval fingerprint: ${migration.requestFingerprint}\nExpires: ${migration.expiresAt}\n\nNo repository identity changed. A workspace owner must approve this exact fingerprint.`,
  );
}

async function complete(repositoryId) {
  const config = await loadConfig();
  const registered = config.repositories?.[repositoryId];
  const pending = config.repositoryIdentityMigrations?.[repositoryId];
  if (!registered || !pending) throw new Error("Run preview before completing a repository identity migration.");
  const current = inspectRepository(registered.path);
  if (
    current.stable.fingerprint !== pending.stableFingerprint ||
    current.commit !== pending.currentHead ||
    current.path !== pending.registeredPath
  )
    throw new Error("Repository identity changed after preview; request a new approval.");
  const response = await signedRequest(
    config,
    "/api/agent-protocol/v1/repositories/identity/complete",
    "RepositoryIdentityMigrationCompleted",
    {
      migrationId: pending.migrationId,
      requestFingerprint: pending.requestFingerprint,
      stableFingerprint: current.stable.fingerprint,
      registeredPath: current.path,
      currentHead: current.commit,
    },
  );
  registered.identityHistory = [
    ...(registered.identityHistory ?? []),
    { identityVersion: registered.identityVersion ?? "legacy-v1", fingerprint: registered.fingerprint },
  ];
  registered.identityVersion = "stable-v2";
  registered.fingerprint = current.stable.fingerprint;
  registered.canonicalRemoteUrl = current.stable.canonicalRemoteUrl;
  delete config.repositoryIdentityMigrations[repositoryId];
  await saveConfig(config);
  console.log(
    `Repository identity migrated.\n\nRepository: ${response.migration.repositoryId}\nIdentity: stable-v2\nFingerprint: ${current.stable.fingerprint}\nThe repository ID, path, permissions, and Project Brain state were preserved.`,
  );
}

async function rollbackLocal(repositoryId, migrationId) {
  const config = await loadConfig();
  const registered = config.repositories?.[repositoryId];
  if (!registered || registered.identityVersion !== "stable-v2")
    throw new Error("The repository does not have an active local stable-v2 identity.");
  const response = await signedRequest(
    config,
    "/api/agent-protocol/v1/repositories/identity/status",
    "RepositoryIdentityMigrationStatusChecked",
    { repositoryId, migrationId },
  );
  const migration = response.migration;
  const legacy = [...(registered.identityHistory ?? [])]
    .reverse()
    .find((identity) => identity.identityVersion === "legacy-v1");
  if (
    migration?.status !== "rolled_back" ||
    migration.repository_id !== repositoryId ||
    migration.stable_fingerprint !== registered.fingerprint ||
    !legacy ||
    migration.legacy_fingerprint !== legacy.fingerprint
  )
    throw new Error("Mission Control has not completed the exact repository identity rollback.");
  registered.fingerprint = legacy.fingerprint;
  registered.identityVersion = "legacy-v1";
  delete registered.canonicalRemoteUrl;
  await saveConfig(config);
  console.log(`Local repository identity rollback completed.\n\nRepository: ${repositoryId}\nIdentity: legacy-v1`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const command = process.argv[2];
    const repositoryId = option("--repository");
    if (command === "preview" && repositoryId) await preview(repositoryId);
    else if (command === "complete" && repositoryId) await complete(repositoryId);
    else if (command === "rollback-local" && repositoryId && option("--migration"))
      await rollbackLocal(repositoryId, option("--migration"));
    else
      throw new Error(
        "Usage: repository-identity-migrator-1.mjs preview|complete --repository <repository-id> [--json]; rollback-local --repository <repository-id> --migration <migration-id>",
      );
  } catch (error) {
    console.error(`Repository identity migrator: ${error instanceof Error ? error.message : "Unknown error"}`);
    process.exitCode = 1;
  }
}
