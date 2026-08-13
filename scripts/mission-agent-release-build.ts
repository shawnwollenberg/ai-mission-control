import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalJson, parseReleaseManifestV2 } from "../integrations/mission-agent/release-authority";

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function main() {
  const artifact = resolve(option("--artifact"));
  const output = resolve(option("--output"));
  const agentVersion = option("--agent-version");
  const sourceCommit = option("--source-commit");
  const expectedChecksum = option("--expected-checksum");
  const bytes = await readFile(artifact);
  const actualChecksum = createHash("sha256").update(Uint8Array.from(bytes)).digest("hex");
  if (actualChecksum !== expectedChecksum) throw new Error("Artifact checksum does not match the approved checksum");

  const manifest = parseReleaseManifestV2({
    activationProtocolVersion: option("--activation-protocol-version"),
    agentVersion,
    artifactPath: `/mission-agent-${agentVersion}.mjs`,
    artifactSha256: actualChecksum,
    buildId: option("--build-id"),
    createdAt: option("--created-at"),
    expiresAt: option("--expires-at"),
    identityProtocolVersion: option("--identity-protocol-version"),
    manifestVersion: "2",
    minimumMissionControlVersion: option("--minimum-mission-control-version"),
    signingKeyId: option("--signing-key-id"),
    sourceCommit,
  });

  await writeFile(output, `${canonicalJson(manifest)}\n`, { flag: "wx", mode: 0o644 });
  console.log(
    JSON.stringify({
      artifact,
      output,
      artifactSha256: actualChecksum,
      sourceCommit,
      signingKeyId: manifest.signingKeyId,
    }),
  );
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
