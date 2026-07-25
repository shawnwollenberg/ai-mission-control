import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  canonicalJson,
  parseCanonicalReleaseManifestJson,
  publicKeyFingerprint,
} from "../integrations/mission-agent/release-authority";

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function main() {
  if (process.env.APP_ENV === "production" || process.env.CI)
    throw new Error("Offline signing is disabled in production and CI");
  const manifestPath = resolve(option("--manifest"));
  const privateKeyPath = resolve(option("--private-key"));
  const output = resolve(option("--output"));
  const confirmedChecksum = option("--confirm-artifact-sha256");
  const expectedFingerprint = option("--expected-public-key-fingerprint");
  const manifest = parseCanonicalReleaseManifestJson(await readFile(manifestPath, "utf8"));
  if (manifest.artifactSha256 !== confirmedChecksum) throw new Error("Explicit artifact-checksum confirmation failed");
  const keyInfo = await lstat(privateKeyPath);
  if (keyInfo.isSymbolicLink() || (keyInfo.mode & 0o077) !== 0)
    throw new Error("Private key must be a non-symlink file with permissions 0600 or stricter");
  if ((await realpath(privateKeyPath)) !== privateKeyPath) throw new Error("Private-key path must be canonical");
  const key = createPrivateKey(await readFile(privateKeyPath));
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Signing key must be Ed25519");
  const spki = createPublicKey(key).export({ format: "der", type: "spki" }) as unknown as Uint8Array;
  const derivedFingerprint = publicKeyFingerprint(Buffer.from(Uint8Array.from(spki)).toString("base64"));
  if (derivedFingerprint !== expectedFingerprint)
    throw new Error("Signing key does not match the approved fingerprint");
  const signature = sign(null, Uint8Array.from(Buffer.from(canonicalJson(manifest))), key).toString("base64");
  await writeFile(output, `${canonicalJson({ ...manifest, signature })}\n`, { flag: "wx", mode: 0o644 });
  console.log(
    JSON.stringify({
      output,
      artifactSha256: manifest.artifactSha256,
      manifestSha256: await import("node:crypto").then(({ createHash }) =>
        createHash("sha256").update(canonicalJson(manifest)).digest("hex"),
      ),
      signingKeyId: manifest.signingKeyId,
      signatureVerified: "requires-public-verifier",
    }),
  );
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
