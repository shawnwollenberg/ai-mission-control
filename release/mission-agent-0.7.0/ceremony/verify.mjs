#!/usr/bin/env node
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";

const [bundlePath, artifactPath, publicKeyPath] = process.argv.slice(2);
if (!bundlePath || !artifactPath || !publicKeyPath)
  throw new Error("Usage: node verify.mjs SIGNED_BUNDLE ARTIFACT PUBLIC_SPKI_DER");
const text = await readFile(bundlePath, "utf8");
const bundle = JSON.parse(text);
const { signature, ...manifest } = bundle;
const canonical = (value) =>
  value && typeof value === "object"
    ? Array.isArray(value)
      ? `[${value.map(canonical).join(",")}]`
      : `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
    : JSON.stringify(value);
if (text.trim() !== canonical(bundle)) throw new Error("Signed bundle is not canonical");
if (
  manifest.manifestVersion !== "2" ||
  manifest.agentVersion !== "0.7.0" ||
  manifest.sourceCommit !== "a6d867f217c6e28ce811fbb5b8bf8778fad193c4" ||
  manifest.signingKeyId !== "mission-agent-release-2026-01"
)
  throw new Error("Signed bundle does not identify the approved candidate");
const artifactSha256 = createHash("sha256")
  .update(await readFile(artifactPath))
  .digest("hex");
if (artifactSha256 !== manifest.artifactSha256) throw new Error("Artifact checksum mismatch");
const signatureBytes = Buffer.from(signature ?? "", "base64");
if (signatureBytes.length !== 64 || signatureBytes.toString("base64") !== signature)
  throw new Error("Signature encoding is not canonical");
const publicKey = createPublicKey({ key: await readFile(publicKeyPath), format: "der", type: "spki" });
if (
  publicKey.asymmetricKeyType !== "ed25519" ||
  !verify(null, Buffer.from(canonical(manifest)), publicKey, signatureBytes)
)
  throw new Error("Signature verification failed");
console.log(
  JSON.stringify({
    verified: true,
    version: manifest.agentVersion,
    artifactSha256,
    signingKeyId: manifest.signingKeyId,
  }),
);
