import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  NODE_ARCHIVE_LENGTH,
  NODE_ARCHIVE_SHA256,
  NODE_ARCHIVE_URL,
  NODE_EXECUTABLE,
  NODE_EXECUTABLE_SHA256,
  TARGET_SERVICE_SHA256,
  validateReplacementAuthorization,
} from "../integrations/mission-agent/replacement-bootstrap.ts";
import { fixedMacOSOperationInventory } from "../application/replacement-bootstrap-macos-local.ts";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const plistPath = "release/mission-agent-0.7.2/replacement-bootstrap/com.wallyweb.mission-agent.plist";

test("canonical launchd plist has deterministic exact bytes and no shell or mutable Node path", async () => {
  const bytes = await readFile(plistPath);
  const text = bytes.toString("utf8");
  assert.equal(bytes.byteLength, 1127);
  assert.equal(sha256(bytes), TARGET_SERVICE_SHA256);
  assert.match(text, new RegExp(NODE_EXECUTABLE));
  assert.equal(text.includes("mission-agent-0.7.2.mjs"), true);
  assert.match(text, /WorkingDirectory/);
  assert.doesNotMatch(text, new RegExp("/bin/(?:sh|bash|zsh)|<string>node</string>|/current/"));
  assert.equal(execFileSync("/usr/bin/plutil", ["-lint", plistPath], { encoding: "utf8" }).includes("OK"), true);
});

test("authorization fixture binds the superseding canonical plist", async () => {
  const fixture = JSON.parse(
    await readFile("release/mission-agent-0.7.2/replacement-bootstrap/simulation-authorization.json", "utf8"),
  );
  const authorization = validateReplacementAuthorization(fixture, {
    now: new Date("2026-07-28T00:00:00.000Z"),
  });
  assert.equal(authorization.serviceReplacement.targetDefinitionSha256, TARGET_SERVICE_SHA256);
});

test("Node runtime manifest matches exact runtime constants and official checksum evidence", async () => {
  const manifest = JSON.parse(
    await readFile("release/mission-agent-0.7.2/replacement-bootstrap/node-runtime.json", "utf8"),
  );
  assert.equal(manifest.distributionUrl, NODE_ARCHIVE_URL);
  assert.equal(manifest.archiveByteLength, NODE_ARCHIVE_LENGTH);
  assert.equal(manifest.archiveSha256, NODE_ARCHIVE_SHA256);
  assert.equal(manifest.executablePath, NODE_EXECUTABLE);
  assert.equal(manifest.executableSha256, NODE_EXECUTABLE_SHA256);
  assert.equal(manifest.redirectPolicy, "reject-all");
  assert.equal(manifest.globalNodeVersionPreserved, "24.10.0");
});

test("macOS provider exposes only fixed executable paths and fixed operations", () => {
  const inventory = fixedMacOSOperationInventory();
  assert.equal(inventory.arbitraryShell, false);
  assert.deepEqual(Object.values(inventory.executables), [
    "/usr/bin/uname",
    "/usr/bin/id",
    "/usr/sbin/scutil",
    "/usr/bin/tar",
    "/bin/launchctl",
    "/bin/ps",
    "/usr/bin/security",
    "/usr/bin/plutil",
  ]);
  assert.equal(inventory.operations.includes("arbitrary_shell"), false);
});
