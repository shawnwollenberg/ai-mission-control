import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  approvedMissionAgentArtifacts,
  verifyMissionAgentArtifact,
} from "../integrations/mission-agent/artifact-manifest.ts";

const approved = approvedMissionAgentArtifacts["0.6.8"].sha256;
const approved072 = approvedMissionAgentArtifacts["0.7.2"].sha256;
test("0.6.8 immutable artifact metadata and approved registry agree", async () => {
  const bytes = await readFile(new URL("../public/mission-agent-0.6.8.mjs", import.meta.url));
  const metadata = JSON.parse(
    await readFile(new URL("../public/mission-agent-0.6.8.mjs.artifact.json", import.meta.url), "utf8"),
  );
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(digest, approved);
  assert.equal(metadata.sha256, approved);
  assert.equal(metadata.manifestVersion, "1");
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

test("signed 0.7.2 heartbeat identity is approved without weakening v3 signer binding", () => {
  const identity = {
    version: "0.7.2",
    sha256: approved072,
    manifestVersion: "3",
    releaseAuthorityVersion: "v2",
    signingKeyId: "mission-agent-release-2026-01",
    publicKeyFingerprint: "ed25519-spki-sha256:7943a55a297cd50faf0a5841d06bcd0046d84dab73cc83543ba4021520706e8b",
  };
  const verified = verifyMissionAgentArtifact("0.7.2", identity);
  assert.equal(verified.status, "verified");
  assert.equal(verified.identityProtocolVersion, "2");
  for (const mutation of [
    { releaseAuthorityVersion: "v1" },
    { signingKeyId: "mission-agent-release-2026-02" },
    { publicKeyFingerprint: `ed25519-spki-sha256:${"0".repeat(64)}` },
    { manifestVersion: "1" },
    { sha256: "0".repeat(64) },
  ])
    assert.equal(verifyMissionAgentArtifact("0.7.2", { ...identity, ...mutation }).status, "mismatch");
});
