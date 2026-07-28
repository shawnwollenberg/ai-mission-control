import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import {
  buildIdentityDigest,
  canonicalJson,
  sha256,
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
    "collect-only": { type: "boolean", default: false },
    sequence: { type: "string" },
  },
  strict: true,
});
const options = parsed.values;
for (const key of ["profile", "region", "image", "digest", "expected", "output"])
  if (!options[key]) throw new Error(`--${key} is required.`);
if (!/^sha256:[a-f0-9]{64}$/.test(options.digest)) throw new Error("ECR image digest is invalid.");
const sequence = Number(options.sequence);
if (!options["collect-only"] && ![1, 2].includes(sequence))
  throw new Error("--sequence must be 1 or 2 for signed image provenance.");
if (!options.image.endsWith(`@${options.digest}`))
  throw new Error("--image must be the exact digest-qualified ECR reference.");
const expected = JSON.parse(await readFile(options.expected, "utf8"));
if (
  !expected.deploymentAttestationKeyArn ||
  !expected.stagingRunId ||
  !/^[a-f0-9]{64}$/.test(expected.bootstrapManifestDigest) ||
  expected.deploymentAttestationKeyArn === expected.missionAgentReleaseKeyArn
)
  throw new Error("Expected identity lacks a distinct deployment-attestation key.");
if (!options["collect-only"] && !expected.signerFunctionArn)
  throw new Error("Expected identity lacks the purpose-bound signer function.");
const imageUrl = new URL(`https://${options.image.split("@")[0]}`);
const repositoryName = imageUrl.pathname.replace(/^\//, "");
const aws = async (args) =>
  JSON.parse(
    (
      await exec("aws", [
        "--profile",
        options.profile,
        "--region",
        options.region,
        "--no-cli-pager",
        ...args,
        "--output",
        "json",
      ])
    ).stdout,
  );
const readEcrManifest = async (digest) => {
  const result = await aws([
    "ecr",
    "batch-get-image",
    "--repository-name",
    repositoryName,
    "--image-ids",
    `imageDigest=${digest}`,
    "--accepted-media-types",
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
  ]);
  if (result.failures?.length || result.images?.length !== 1) throw new Error("Exact OCI manifest is unavailable.");
  const raw = result.images[0].imageManifest;
  if (`sha256:${sha256(raw)}` !== digest) throw new Error("ECR OCI manifest bytes contradict the selected digest.");
  return { raw, manifest: JSON.parse(raw) };
};
const rootManifest = await readEcrManifest(options.digest);
let platformManifestDigest = options.digest;
let platformManifest = rootManifest.manifest;
if (Array.isArray(rootManifest.manifest.manifests)) {
  const selected = rootManifest.manifest.manifests.filter(
    ({ platform, artifactType }) => platform?.os === "linux" && platform?.architecture === "arm64" && !artifactType,
  );
  if (selected.length !== 1) throw new Error("OCI index lacks one exact Linux ARM64 application manifest.");
  platformManifestDigest = selected[0].digest;
  platformManifest = (await readEcrManifest(platformManifestDigest)).manifest;
}
if (!/^sha256:[a-f0-9]{64}$/.test(platformManifest.config?.digest))
  throw new Error("OCI application manifest lacks an immutable image configuration digest.");
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
  imageReference: options.image,
  ociManifestDigest: options.digest,
  ociPlatformManifestDigest: platformManifestDigest,
  ociImageConfigurationDigest: platformManifest.config.digest,
  bootstrapManifestDigest: expected.bootstrapManifestDigest,
  buildIdentityDigest: buildIdentityDigest(provenance),
  provenance,
  embeddedProvenanceVerified: true,
  signingKeyArn: expected.deploymentAttestationKeyArn,
};
if (options["collect-only"]) {
  await writeFile(options.output, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  process.stdout.write(
    `${JSON.stringify({ output: options.output, collectedOnly: true, imageDigest: options.digest, buildIdentityDigest: payload.buildIdentityDigest })}\n`,
  );
  process.exit(0);
}
const now = new Date();
const attestationRequest = {
  schemaVersion: "mission-control-v1-staging-attestation-request/1",
  kind: "image-provenance",
  runId: expected.stagingRunId,
  accountId: expected.awsAccountId,
  region: options.region,
  bootstrapManifestDigest: expected.bootstrapManifestDigest,
  observedAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
  nonce: randomUUID(),
  sequence,
  evidence: payload,
};
const scratch = await mkdtemp(join(tmpdir(), "mission-control-v1-attestation-"));
const responsePath = join(scratch, "response.json");
let signed;
try {
  const invocation = await exec("aws", [
    "--profile",
    options.profile,
    "--region",
    options.region,
    "--no-cli-pager",
    "lambda",
    "invoke",
    "--function-name",
    expected.signerFunctionArn,
    "--cli-binary-format",
    "raw-in-base64-out",
    "--payload",
    canonicalJson({ canonicalEnvelope: canonicalJson(attestationRequest) }),
    responsePath,
    "--output",
    "json",
  ]);
  const metadata = JSON.parse(invocation.stdout);
  if (metadata.FunctionError) throw new Error("Staging attestation signer rejected image provenance.");
  signed = JSON.parse(await readFile(responsePath, "utf8"));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
if (signed.keyId !== expected.deploymentAttestationKeyArn) throw new Error("Signer used an unexpected key.");
await writeFile(
  options.output,
  `${JSON.stringify({ ...payload, attestationRequest, signature: signed.signature }, null, 2)}\n`,
  {
    mode: 0o600,
  },
);
process.stdout.write(
  `${JSON.stringify({ output: options.output, imageDigest: options.digest, buildIdentityDigest: payload.buildIdentityDigest })}\n`,
);
