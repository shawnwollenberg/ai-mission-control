import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  parseCanonicalSignedReleaseManifestJson,
  verifyReleaseManifestV2,
} from "../integrations/mission-agent/release-authority";

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function main() {
  const bundlePath = resolve(option("--bundle"));
  const artifactPath = resolve(option("--artifact"));
  const bundle = parseCanonicalSignedReleaseManifestJson(await readFile(bundlePath, "utf8"));
  const manifest = verifyReleaseManifestV2(bundle);
  const actualChecksum = createHash("sha256")
    .update(Uint8Array.from(await readFile(artifactPath)))
    .digest("hex");
  if (actualChecksum !== manifest.artifactSha256) throw new Error("Artifact checksum does not match signed manifest");
  if (process.argv.includes("--source-commit") && option("--source-commit") !== manifest.sourceCommit)
    throw new Error("Source commit does not match signed manifest");
  console.log(
    JSON.stringify({
      verified: true,
      agentVersion: manifest.agentVersion,
      artifactSha256: actualChecksum,
      sourceCommit: manifest.sourceCommit,
      signingKeyId: manifest.signingKeyId,
    }),
  );
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
