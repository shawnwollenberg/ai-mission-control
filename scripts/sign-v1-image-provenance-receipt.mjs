import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs, promisify } from "node:util";
import {
  buildIdentityDigest,
  canonicalJson,
  validateBuildProvenance,
} from "../application/v1-production-runtime-identity.ts";

const exec = promisify(execFile);
const parsed = parseArgs({
  options: {
    profile: { type: "string" },
    region: { type: "string" },
    image: { type: "string" },
    digest: { type: "string" },
    expected: { type: "string" },
    output: { type: "string" },
  },
  strict: true,
});
const options = parsed.values;
for (const key of ["profile", "region", "image", "digest", "expected", "output"])
  if (!options[key]) throw new Error(`--${key} is required.`);
if (!/^sha256:[a-f0-9]{64}$/.test(options.digest)) throw new Error("ECR image digest is invalid.");
if (!options.image.endsWith(`@${options.digest}`))
  throw new Error("--image must be the exact digest-qualified ECR reference.");
const expected = JSON.parse(await readFile(options.expected, "utf8"));
if (
  !expected.deploymentAttestationKeyArn ||
  expected.deploymentAttestationKeyArn === expected.missionAgentReleaseKeyArn
)
  throw new Error("Expected identity lacks a distinct deployment-attestation key.");
await exec("docker", ["pull", options.image]);
const repoDigests = JSON.parse(
  (await exec("docker", ["image", "inspect", "--format", "{{json .RepoDigests}}", options.image])).stdout.trim(),
);
if (!repoDigests.includes(options.image))
  throw new Error("Docker did not resolve the exact ECR digest selected for provenance.");
const inspected = await exec("docker", [
  "run",
  "--rm",
  "--network",
  "none",
  "--entrypoint",
  "cat",
  options.image,
  "/app/mission-control-build-provenance.json",
]);
const provenance = JSON.parse(inspected.stdout);
validateBuildProvenance(provenance);
if (
  provenance.buildMode !== "production" ||
  provenance.sourceState !== "clean" ||
  provenance.sourceCommit !== expected.applicationCommit
)
  throw new Error("Embedded image provenance is not an approved clean production build.");
const payload = {
  schemaVersion: "mission-control-image-provenance-receipt-v1",
  imageDigest: options.digest,
  buildIdentityDigest: buildIdentityDigest(provenance),
  provenance,
  embeddedProvenanceVerified: true,
  signingKeyArn: expected.deploymentAttestationKeyArn,
};
const sign = await exec("aws", [
  "--profile",
  options.profile,
  "--region",
  options.region,
  "--no-cli-pager",
  "kms",
  "sign",
  "--key-id",
  expected.deploymentAttestationKeyArn,
  "--message-type",
  "RAW",
  "--signing-algorithm",
  "ED25519_SHA_512",
  "--message",
  Buffer.from(canonicalJson(payload), "utf8").toString("base64"),
  "--output",
  "json",
]);
const signed = JSON.parse(sign.stdout);
if (signed.KeyId !== expected.deploymentAttestationKeyArn) throw new Error("KMS signed with an unexpected key.");
await writeFile(options.output, `${JSON.stringify({ ...payload, signature: signed.Signature }, null, 2)}\n`, {
  mode: 0o600,
});
process.stdout.write(
  `${JSON.stringify({ output: options.output, imageDigest: options.digest, buildIdentityDigest: payload.buildIdentityDigest })}\n`,
);
