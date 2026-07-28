import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, rename } from "node:fs/promises";

const source = new URL("../dist/mission-agent-replacement-operator-v1.mjs", import.meta.url);
const metadata = JSON.parse(
  await readFile(new URL("../dist/mission-agent-replacement-operator-v1.json", import.meta.url), "utf8"),
);
const destination =
  "/Users/shawnwollenberg/Library/Application Support/WallyWeb/MissionAgentReplacement/operator-v1.mjs";
if (process.platform !== "darwin" || !process.getuid || process.getuid() === 0)
  throw new Error("The v1 operator installer requires the non-root owner account on macOS.");
if (metadata.installPath !== destination || !/^[a-f0-9]{64}$/.test(metadata.sha256))
  throw new Error("Operator artifact metadata is malformed or targets an unapproved path.");
const bytes = await readFile(source);
if (createHash("sha256").update(bytes).digest("hex") !== metadata.sha256)
  throw new Error("Operator artifact checksum does not match its build record.");
const directory = destination.slice(0, destination.lastIndexOf("/"));
await mkdir(directory, { recursive: true, mode: 0o700 });
const directoryInfo = await lstat(directory);
if (directoryInfo.uid !== process.getuid() || (directoryInfo.mode & 0o077) !== 0)
  throw new Error("Operator installation directory ownership or permissions are unsafe.");
const temporary = `${destination}.installing`;
await copyFile(source, temporary);
await chmod(temporary, 0o500);
await rename(temporary, destination);
const installed = await lstat(destination);
if (
  installed.uid !== process.getuid() ||
  (installed.mode & 0o777) !== 0o500 ||
  createHash("sha256")
    .update(await readFile(destination))
    .digest("hex") !== metadata.sha256
)
  throw new Error("Installed operator ownership, permissions, or checksum verification failed.");
process.stdout.write(
  `${JSON.stringify({ installed: true, path: destination, sha256: metadata.sha256, uid: installed.uid, mode: "0500" })}\n`,
);
