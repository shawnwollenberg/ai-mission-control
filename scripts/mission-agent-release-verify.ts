import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { resolve } from "node:path";
import { acceptMissionAgentProductionRelease } from "../application/mission-agent-release-selection";

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function main() {
  const bundlePath = resolve(option("--bundle"));
  const artifactPath = resolve(option("--artifact"));
  const artifactBytes = await readFile(artifactPath);
  const manifest = acceptMissionAgentProductionRelease({
    signedManifestText: await readFile(bundlePath, "utf8"),
    artifactBytes: Uint8Array.from(artifactBytes),
    artifactName: basename(artifactPath),
  });
  if (process.argv.includes("--source-commit") && option("--source-commit") !== manifest.build.sourceCommit)
    throw new Error("Source commit does not match signed manifest");
  console.log(
    JSON.stringify({
      verified: true,
      agentVersion: manifest.releaseVersion,
      artifactSha256: manifest.artifactSha256,
      sourceCommit: manifest.build.sourceCommit,
      signingKeyId: manifest.signingKeyId,
    }),
  );
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
