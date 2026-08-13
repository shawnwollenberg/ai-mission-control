import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createConnection } from "node:net";
import test from "node:test";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
};

async function serverFixture() {
  const source = await readFile(resolve("scripts/mission-agent-080.template.mjs"), "utf8");
  const match = source.match(/const serverSource = String\.raw`([\s\S]*?)`;[\s\S]{0,1200}?await writeFile\(serverPath/);
  assert.ok(match, "embedded implementation tool server must remain extractable for executable tests");
  const fixtureRoot = await mkdtemp(join(tmpdir(), "codex-implementation-tools-"));
  const worktree = join(fixtureRoot, "worktree");
  const provider = join(fixtureRoot, "provider");
  const supervisor = join(fixtureRoot, "mission-agent-supervisor");
  await mkdir(worktree, { mode: 0o700 });
  await mkdir(provider, { mode: 0o700 });
  await mkdir(supervisor, { mode: 0o700 });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: worktree }).status, 0);
  await writeFile(join(worktree, "README.md"), "before\n");
  await writeFile(
    join(worktree, "validate.mjs"),
    'process.exit((await import("node:fs")).readFileSync("README.md","utf8").includes("after")?0:1)\n',
  );
  await writeFile(
    join(worktree, "long-validation.mjs"),
    'import {writeFileSync} from "node:fs"; writeFileSync(process.argv[2],String(process.pid)); setInterval(()=>{},1000);\n',
  );
  assert.equal(spawnSync("git", ["add", "."], { cwd: worktree }).status, 0);
  assert.equal(
    spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base"], {
      cwd: worktree,
    }).status,
    0,
  );
  const commands = [
    ["node", "validate.mjs"],
    ["node", "long-validation.mjs", join(worktree, "validation.pid")],
  ];
  const canonicalWorktree = await realpath(worktree);
  const capability = {
    schemaVersion: "codex-implementation-tools/1",
    assignmentId: "assignment-fixture",
    assignmentAttempt: 1,
    executionId: "execution-fixture",
    providerAttemptId: "1-1",
    canonicalPlanHash: sha256("canonical-plan-fixture"),
    fencingToken: 7,
    timeoutSeconds: 30,
    deniedHomePath: await realpath(homedir()),
    worktreePath: canonicalWorktree,
    worktreeIdentitySha256: sha256(canonicalWorktree),
    approvedValidationCommands: commands,
    approvedValidationCommandsSha256: sha256(canonical(commands)),
  };
  capability.capabilitySha256 = sha256(canonical(capability));
  const server = join(supervisor, "server.mjs");
  const capabilityPath = join(supervisor, "capability.json");
  const journal = join(supervisor, "journal.jsonl");
  const socket = join(provider, "tools.sock");
  await writeFile(server, match[1], { mode: 0o700 });
  await writeFile(capabilityPath, JSON.stringify(capability), { mode: 0o600 });
  return { fixtureRoot, worktree, provider, supervisor, server, capabilityPath, journal, socket };
}

async function client(fixture) {
  const child = spawn(process.execPath, [fixture.server, fixture.capabilityPath, fixture.journal, fixture.socket], {
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const connected = await new Promise((resolveConnected) => {
      const probe = createConnection(fixture.socket);
      probe.once("connect", () => {
        probe.end();
        resolveConnected(true);
      });
      probe.once("error", () => resolveConnected(false));
    });
    if (connected) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  const connection = createConnection(fixture.socket);
  await once(connection, "connect");
  let buffer = "";
  const pending = new Map();
  connection.setEncoding("utf8");
  connection.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      pending.get(message.id)?.(message.result);
      pending.delete(message.id);
    }
  });
  let nextId = 1;
  const request = (method, params = {}) =>
    new Promise((resolveRequest) => {
      const id = nextId++;
      pending.set(id, resolveRequest);
      connection.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  return { child, connection, request };
}

test("Codex implementation tools provide bounded inspect/edit/diff/validation evidence", async () => {
  const fixture = await serverFixture();
  const { child, connection, request } = await client(fixture);
  try {
    const initialized = await request("initialize", {});
    assert.equal(initialized.serverInfo.name, "mission-agent-worktree");
    assert.notEqual(fixture.provider, fixture.supervisor);
    const listed = await request("tools/list", {});
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      [
        "inspect_worktree",
        "read_worktree_file",
        "write_worktree_file",
        "delete_worktree_file",
        "inspect_worktree_diff",
        "run_approved_validation_command",
      ],
    );
    assert.match(
      JSON.parse((await request("tools/call", { name: "inspect_worktree", arguments: {} })).content[0].text).status,
      /^$/,
    );
    const read = JSON.parse(
      (await request("tools/call", { name: "read_worktree_file", arguments: { path: "README.md" } })).content[0].text,
    );
    assert.equal(read.content, "before\n");
    await request("tools/call", {
      name: "write_worktree_file",
      arguments: { path: "README.md", content: "after\n" },
    });
    await request("tools/call", {
      name: "write_worktree_file",
      arguments: { path: "temporary.txt", content: "temporary\n" },
    });
    await request("tools/call", { name: "delete_worktree_file", arguments: { path: "temporary.txt" } });
    const diff = JSON.parse(
      (await request("tools/call", { name: "inspect_worktree_diff", arguments: {} })).content[0].text,
    );
    assert.match(diff.diff, /\+after/);
    const validation = JSON.parse(
      (await request("tools/call", { name: "run_approved_validation_command", arguments: { commandIndex: 0 } }))
        .content[0].text,
    );
    assert.equal(validation.exitCode, 0);

    for (const attempt of [
      { name: "read_worktree_file", arguments: { path: "../outside-secret" }, reason: "WORKTREE_PATH_FORBIDDEN" },
      {
        name: "read_worktree_file",
        arguments: { path: join(process.env.HOME, ".codex", "auth.json") },
        reason: "WORKTREE_PATH_FORBIDDEN",
      },
      {
        name: "write_worktree_file",
        arguments: { path: "../outside", content: "denied" },
        reason: "WORKTREE_PATH_FORBIDDEN",
      },
      {
        name: "write_worktree_file",
        arguments: { path: ".git/config", content: "denied" },
        reason: "GIT_METADATA_FORBIDDEN",
      },
      {
        name: "run_approved_validation_command",
        arguments: { commandIndex: 2 },
        reason: "VALIDATION_COMMAND_NOT_APPROVED",
      },
    ]) {
      const result = await request("tools/call", attempt);
      assert.equal(result.isError, true);
      assert.equal(JSON.parse(result.content[0].text).reasonCode, attempt.reason);
    }
    const journal = (await readFile(fixture.journal, "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(journal.some((entry) => entry.tool === "inspect_worktree_diff" && entry.outcome === "succeeded"));
    assert.ok(
      journal.some((entry) => entry.tool === "run_approved_validation_command" && entry.outcome === "succeeded"),
    );
    assert.ok(journal.some((entry) => entry.outcome === "rejected"));
    assert.ok(
      journal.every((entry) => entry.providerAttemptId === "1-1" && !JSON.stringify(entry).includes("outside-secret")),
    );
    assert.equal(spawnSync("git", ["remote"], { cwd: fixture.worktree, encoding: "utf8" }).stdout, "");
  } finally {
    const closed = once(child, "close");
    connection.end();
    child.stdin.end();
    await closed;
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("Codex implementation supervisor cancellation terminates its validation process group", async () => {
  const fixture = await serverFixture();
  const { child, connection, request } = await client(fixture);
  try {
    void request("tools/call", { name: "run_approved_validation_command", arguments: { commandIndex: 1 } });
    const pidPath = join(fixture.worktree, "validation.pid");
    let validationPid;
    for (let attempt = 0; attempt < 100 && !validationPid; attempt += 1) {
      validationPid = Number.parseInt(await readFile(pidPath, "utf8").catch(() => ""), 10) || undefined;
      if (!validationPid) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    assert.ok(validationPid);
    const closed = once(child, "close");
    process.kill(-child.pid, "SIGTERM");
    await closed;
    assert.throws(() => process.kill(validationPid, 0));
  } finally {
    connection.destroy();
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("Codex implementation prompt keeps shell disabled and preserves no-change rejection", async () => {
  const source = await readFile(resolve("scripts/mission-agent-080.template.mjs"), "utf8");
  assert.match(source, /Use only the mission_agent_worktree tools/);
  assert.match(source, /"--disable",\s*"shell_tool"/);
  assert.match(source, /mcp_servers\.mission_agent_worktree\.command/);
  assert.match(source, /mcp_servers\.mission_agent_worktree\.args/);
  assert.match(source, /await realpath\("\/private\/tmp"\)/);
  assert.match(source, /`mc-it-\$\{sha256\(`/);
  assert.match(source, /const socketRoot = join\(supervisorRoot, "s"\)/);
  assert.match(source, /supervisor root already exists/);
  assert.match(source, /sha256\(supervisorRegistrationId\)\.slice\(0, 24\)/);
  assert.match(source, /Buffer\.byteLength\(socketPath\) > 100/);
  assert.match(source, /codexImplementationTools\.socketPath,\n\s*\)\.finally/);
  assert.match(source, /produced no repository changes/);
  assert.match(source, /isolatedValidation\(command, worktreePath\)/);
});
