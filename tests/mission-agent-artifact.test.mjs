import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  approvedMissionAgentArtifacts,
  verifyMissionAgentArtifact,
} from "../integrations/mission-agent/artifact-manifest.ts";

const approved = approvedMissionAgentArtifacts["0.6.8"].sha256;
const { verifyReleaseManifest } = await import("../public/mission-agent-0.6.8.mjs");

test("0.6.8 artifact, detached manifest, and approved registry agree", async () => {
  const bytes = await readFile(new URL("../public/mission-agent-0.6.8.mjs", import.meta.url));
  const metadata = JSON.parse(
    await readFile(new URL("../public/mission-agent-0.6.8.mjs.artifact.json", import.meta.url), "utf8"),
  );
  const published = JSON.parse(await readFile(new URL("../public/mission-agent-latest.json", import.meta.url), "utf8"));
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(digest, approved);
  assert.equal(metadata.sha256, approved);
  assert.equal(published.sha256, approved);
  assert.equal(metadata.manifestVersion, "1");
  assert.equal(published.manifestVersion, "1");
  assert.equal(verifyReleaseManifest(published, true).sha256, approved);
  assert.throws(
    () => verifyReleaseManifest({ ...published, sha256: "a".repeat(64) }, true),
    /signature verification failed/,
  );
  assert.throws(() => verifyReleaseManifest({ ...published, signature: "" }, true), /signature verification failed/);
});

test("artifact verification accepts only the approved canonical identity", () => {
  assert.equal(verifyMissionAgentArtifact("0.6.8", { sha256: approved, manifestVersion: "1" }).status, "verified");
  for (const [version, artifact, status] of [
    ["0.6.8", undefined, "missing"],
    ["0.6.8", { sha256: "", manifestVersion: "1" }, "missing"],
    ["0.6.8", { sha256: approved.toUpperCase(), manifestVersion: "1" }, "malformed"],
    ["0.6.8", { sha256: "a".repeat(63), manifestVersion: "1" }, "malformed"],
    ["0.6.8", { sha256: "z".repeat(64), manifestVersion: "1" }, "malformed"],
    ["0.6.8", { sha256: "a".repeat(64), manifestVersion: "1" }, "mismatch"],
    ["0.6.7", { sha256: approved, manifestVersion: "1" }, "unapproved_version"],
    ["9.9.9", { sha256: approved, manifestVersion: "1" }, "unapproved_version"],
  ])
    assert.equal(verifyMissionAgentArtifact(version, artifact).status, status);
});

test("signed Mission Agent 0.7.2 Manifest v3 artifact identity is exact", () => {
  const checksum = "108e5587e8ffce0c37639e041cd2dcc2b51079f395beb04b26c1d4d9330bee09";
  assert.equal(verifyMissionAgentArtifact("0.7.2", { sha256: checksum, manifestVersion: "3" }).status, "verified");
  assert.equal(verifyMissionAgentArtifact("0.7.2", { sha256: checksum, manifestVersion: "1" }).status, "malformed");
});
