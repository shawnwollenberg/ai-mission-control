import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const output = resolve("dist/mission-agent-replacement-operator-v1.mjs");
await mkdir(resolve("dist"), { recursive: true });
await build({
  entryPoints: [resolve("scripts/v1-macos-operator.ts")],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "bundle",
  legalComments: "none",
  sourcemap: false,
  minify: false,
  banner: { js: "#!/usr/bin/env node" },
});
const bytes = await readFile(output);
const checksum = createHash("sha256").update(bytes).digest("hex");
await writeFile(
  resolve("dist/mission-agent-replacement-operator-v1.json"),
  `${JSON.stringify(
    {
      schemaVersion: "mission-agent-replacement-operator-artifact-v1",
      artifact: "dist/mission-agent-replacement-operator-v1.mjs",
      sha256: checksum,
      byteLength: bytes.length,
      installPath:
        "/Users/shawnwollenberg/Library/Application Support/WallyWeb/MissionAgentReplacement/operator-v1.mjs",
      mode: "0500",
      launchAgentLabel: "com.wallyweb.mission-agent.replacement-operator",
      appleCodeSigning: "deferred-v1-owner-controlled-mac",
      notarization: "deferred-v1-owner-controlled-mac",
    },
    null,
    2,
  )}\n`,
);
process.stdout.write(`${JSON.stringify({ output, sha256: checksum, byteLength: bytes.length })}\n`);
