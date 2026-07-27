import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  canonicalReleaseManifestV3,
  parseReleaseManifestV3,
  type ReleaseManifestV3,
} from "../integrations/mission-agent/release-authority";

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function main() {
  const artifact = resolve(option("--artifact"));
  const output = resolve(option("--output"));
  const bytes = await readFile(artifact);
  const details = await stat(artifact);
  const manifest: ReleaseManifestV3 = parseReleaseManifestV3({
    artifactByteLength: details.size,
    artifactName: basename(artifact),
    artifactSha256: createHash("sha256").update(Uint8Array.from(bytes)).digest("hex"),
    build: {
      buildId: option("--build-id"),
      sourceCommit: option("--source-commit"),
    },
    canonicalizationVersion: "release-manifest-json-v3",
    compatibility: {
      activationProtocolVersion: option("--activation-protocol-version"),
      identityProtocolVersion: option("--identity-protocol-version"),
      minimumMissionControlVersion: option("--minimum-mission-control-version"),
    },
    createdAt: option("--created-at"),
    expiresAt: option("--expires-at"),
    manifestVersion: "3",
    platform: {
      architecture: "universal",
      artifactFormat: "esm",
      operatingSystem: "darwin-linux",
      runtime: "node",
      runtimeMajorVersion: 22,
    },
    publicKeyFingerprint: option("--public-key-fingerprint"),
    releaseAuthorityVersion: "v2",
    releaseVersion: option("--release-version"),
    signingKeyId: option("--signing-key-id"),
  });
  const canonical = canonicalReleaseManifestV3(manifest);
  await writeFile(output, canonical, { flag: "wx", mode: 0o644 });
  console.log(
    JSON.stringify({
      artifact,
      artifactByteLength: details.size,
      artifactSha256: manifest.artifactSha256,
      canonicalByteLength: Buffer.byteLength(canonical),
      canonicalSha256: createHash("sha256").update(canonical).digest("hex"),
      output,
    }),
  );
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
