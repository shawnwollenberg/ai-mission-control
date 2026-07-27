import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const sourceCommitIndex = process.argv.indexOf("--source-commit");
const sourceCommit = sourceCommitIndex >= 0 ? process.argv[sourceCommitIndex + 1] : undefined;
if (!/^[a-f0-9]{40}$/.test(sourceCommit ?? "")) throw new Error("Provide --source-commit as a full lowercase Git SHA");

const sourcePath = resolve("public/mission-agent-0.7.0.mjs");
const targetPath = resolve(
  process.argv.includes("--output")
    ? process.argv[process.argv.indexOf("--output") + 1]
    : "public/mission-agent-0.7.1.mjs",
);
let source = await readFile(sourcePath, "utf8");

source = source
  .replace('const VERSION = "0.7.0";', 'const VERSION = "0.7.1";')
  .replace(/const BUILD_SOURCE_COMMIT = "[a-f0-9]{40}";/, `const BUILD_SOURCE_COMMIT = "${sourceCommit}";`)
  .replace(
    "  // RELEASE_AUTHORITY_V2_PENDING_KEY_INSERTION_POINT",
    `  "mission-agent-release-2026-01": Object.freeze({
    keyId: "mission-agent-release-2026-01",
    algorithm: "Ed25519",
    publicKeySpkiBase64: "MCowBQYDK2VwAyEAvSkEoddFoGfJn2PauL+KEl4ykZ+5WM5B2PklJOZOAKE=",
    publicKeyFingerprint: "ed25519-spki-sha256:7943a55a297cd50faf0a5841d06bcd0046d84dab73cc83543ba4021520706e8b",
    status: "active",
    purpose: "mission-agent-release",
    signingAlgorithm: "ED25519_SHA_512",
    releaseAuthorityVersion: "2",
    manifestVersion: "2",
    bootstrap: "production-trust-root-0.7.1",
    activatedAt: "2026-07-27T16:00:31.000Z",
    retiresAt: null,
    revokedAt: null,
  }),
  // RELEASE_AUTHORITY_V2_PENDING_KEY_INSERTION_POINT`,
  )
  .replace(
    "  const store = validateReleaseTrustStore(options.trustStore);",
    `  if (options.trustStore && options.allowTestTrustStoreOverride !== true)
    throw new Error("External release trust-store override is not authorized.");
  const store = validateReleaseTrustStore(
    options.allowTestTrustStoreOverride === true ? options.trustStore : undefined,
  );`,
  );

if (
  source.includes('const VERSION = "0.7.0";') ||
  !source.includes('const VERSION = "0.7.1";') ||
  !source.includes("production-trust-root-0.7.1") ||
  !source.includes("External release trust-store override is not authorized.")
)
  throw new Error("Mission Agent 0.7.1 transformation was incomplete");

await writeFile(targetPath, source, { mode: 0o700 });
