import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { canonicalHash } from "../lib/canonical-json.ts";

const sources = [
  "app/api/agent-protocol/v1/messages/route.ts",
  "application/acceptance-authority-presentation-observations.ts",
  "application/remote-agent-messages.ts",
];
const serverRoot = resolve(".next/standalone/.next/server");
const sha = async (path) =>
  createHash("sha256")
    .update(await readFile(resolve(path)))
    .digest("hex");
const entries = await readdir(serverRoot, { recursive: true, withFileTypes: true });
const boundaryFiles = [];
for (const entry of entries) {
  if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
  const path = resolve(entry.parentPath, entry.name);
  const text = await readFile(path, "utf8");
  if (
    text.includes("agent-protocol.messages.POST/active-execution-fence/1") ||
    text.includes("ASSIGNMENT_EXECUTABLE_BINDING_CHANGED")
  )
    boundaryFiles.push(relative(process.cwd(), path));
}
boundaryFiles.sort();
if (!boundaryFiles.length) throw new Error("Standalone build omitted the active execution-authority boundary");
const receipt = {
  schemaVersion: "acceptance-standalone-authority-build/1",
  sourceHashes: Object.fromEntries(await Promise.all(sources.map(async (path) => [path, await sha(path)]))),
  boundaryHashes: Object.fromEntries(await Promise.all(boundaryFiles.map(async (path) => [path, await sha(path)]))),
};
const output = { ...receipt, identitySha256: canonicalHash(receipt) };
await writeFile(
  join(resolve(".next/standalone/.next"), "acceptance-authority-build.json"),
  `${JSON.stringify(output, null, 2)}\n`,
);
console.log(JSON.stringify({ event: "acceptance_standalone_authority_bound", ...output }));
