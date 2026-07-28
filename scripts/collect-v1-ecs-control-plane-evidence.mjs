import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import {
  canonicalJson,
  buildIdentityDigest,
  sha256,
  validateBuildProvenance,
  validateEcsControlPlaneIdentity,
} from "../application/v1-production-runtime-identity.ts";

const exec = promisify(execFile);
const parsed = parseArgs({
  options: {
    profile: { type: "string" },
    region: { type: "string" },
    cluster: { type: "string" },
    service: { type: "string" },
    expected: { type: "string" },
    output: { type: "string" },
    "signer-function": { type: "string" },
    "build-receipts": { type: "string" },
  },
  strict: true,
});
const options = parsed.values;
for (const key of [
  "profile",
  "region",
  "cluster",
  "service",
  "expected",
  "output",
  "signer-function",
  "build-receipts",
])
  if (!options[key]) throw new Error(`--${key} is required.`);
if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(options.region)) throw new Error("AWS region is invalid.");

async function aws(args) {
  const result = await exec("aws", [
    "--profile",
    options.profile,
    "--region",
    options.region,
    "--no-cli-pager",
    ...args,
    "--output",
    "json",
  ]);
  return JSON.parse(result.stdout);
}

const expected = JSON.parse(await readFile(options.expected, "utf8"));
const buildReceipts = JSON.parse(await readFile(options["build-receipts"], "utf8"));
for (const key of [
  "awsAccountId",
  "region",
  "clusterArn",
  "serviceArn",
  "deploymentId",
  "taskDefinitionArn",
  "taskArn",
  "desiredCount",
  "pendingCount",
  "deploymentCount",
  "primaryRolloutState",
  "taskLastStatus",
  "taskHealthStatus",
  "targetHealth",
  "ecrRepositoryArn",
  "imageDigest",
  "containers",
  "taskRoleArn",
  "executionRoleArn",
  "configurationDigest",
  "applicationCommit",
  "buildIdentityDigest",
  "maximumEvidenceAgeMs",
  "deploymentAttestationKeyArn",
  "missionAgentReleaseKeyArn",
  "stagingRunId",
  "bootstrapManifestDigest",
  "signerFunctionArn",
])
  if (expected[key] === undefined) throw new Error(`Expected identity is incomplete: ${key}.`);
if (
  options["signer-function"] !== expected.signerFunctionArn ||
  expected.deploymentAttestationKeyArn === expected.missionAgentReleaseKeyArn
)
  throw new Error("Deployment attestation requires its exact purpose-bound non-release KMS key.");
const caller = await aws(["sts", "get-caller-identity"]);
const serviceResult = await aws([
  "ecs",
  "describe-services",
  "--cluster",
  options.cluster,
  "--services",
  options.service,
]);
if (serviceResult.failures?.length || serviceResult.services?.length !== 1)
  throw new Error("ECS service identity could not be established.");
const service = serviceResult.services[0];
const primaryDeployments = (service.deployments ?? []).filter(({ status }) => status === "PRIMARY");
if (
  service.pendingCount !== 0 ||
  service.deployments?.length !== 1 ||
  primaryDeployments.length !== 1 ||
  primaryDeployments[0].rolloutState !== "COMPLETED"
)
  throw new Error("ECS service is not in a completed single-deployment steady state.");
const taskResult = await aws([
  "ecs",
  "list-tasks",
  "--cluster",
  options.cluster,
  "--service-name",
  options.service,
  "--desired-status",
  "RUNNING",
]);
if (taskResult.taskArns?.length !== 1) throw new Error("V1 requires exactly one running ECS task.");
const describedTasks = await aws([
  "ecs",
  "describe-tasks",
  "--cluster",
  options.cluster,
  "--tasks",
  taskResult.taskArns[0],
]);
if (describedTasks.failures?.length || describedTasks.tasks?.length !== 1)
  throw new Error("Running ECS task could not be described.");
const task = describedTasks.tasks[0];
if (task.lastStatus !== "RUNNING" || task.healthStatus !== "HEALTHY")
  throw new Error("ECS task is not running and healthy.");
const targetGroupArn = service.loadBalancers?.[0]?.targetGroupArn;
const privateIp = task.attachments
  ?.flatMap(({ details = [] }) => details)
  .find(({ name }) => name === "privateIPv4Address")?.value;
if (!targetGroupArn || !privateIp) throw new Error("ECS load-balancer target identity is unavailable.");
const targetHealthResult = await aws(["elbv2", "describe-target-health", "--target-group-arn", targetGroupArn]);
const matchingTargets = (targetHealthResult.TargetHealthDescriptions ?? []).filter(
  ({ Target }) => Target?.Id === privateIp && Target?.Port === 3000,
);
if (matchingTargets.length !== 1 || matchingTargets[0].TargetHealth?.State !== "healthy")
  throw new Error("The exact running ECS task is not the healthy load-balancer target.");
const taskDefinitionResult = await aws([
  "ecs",
  "describe-task-definition",
  "--task-definition",
  task.taskDefinitionArn,
  "--include",
  "TAGS",
]);
const taskDefinition = taskDefinitionResult.taskDefinition;
const expectedContainerNames = ["generic-worker", "project-brain-worker", "remote-agent-worker", "web"];
const containerNames = taskDefinition.containerDefinitions.map(({ name }) => name).sort();
if (JSON.stringify(containerNames) !== JSON.stringify(expectedContainerNames))
  throw new Error("ECS task does not contain the exact v1 executable container set.");
const web = taskDefinition.containerDefinitions.find(({ name }) => name === "web");
if (!web?.image?.includes("@sha256:")) throw new Error("Web task image is not digest-pinned.");
const [repositoryUri, imageDigest] = web.image.split("@");
const repositoryName = repositoryUri.split("/").at(-1);
const containers = Object.fromEntries(
  taskDefinition.containerDefinitions.map(({ name, image, command = [], essential = false }) => {
    if (!image.startsWith(`${repositoryUri}@sha256:`))
      throw new Error(`Container ${name} is not pinned to the expected ECR repository and digest.`);
    return [name, { imageDigest: image.split("@")[1], command, essential }];
  }),
);
for (const containerDigest of new Set(Object.values(containers).map(({ imageDigest: digest }) => digest))) {
  const ecr = await aws([
    "ecr",
    "describe-images",
    "--repository-name",
    repositoryName,
    "--image-ids",
    `imageDigest=${containerDigest}`,
  ]);
  if (ecr.imageDetails?.length !== 1 || ecr.imageDetails[0].imageDigest !== containerDigest)
    throw new Error(`ECR does not contain executable container digest ${containerDigest}.`);
  const receipt = buildReceipts.find(({ imageDigest: receiptDigest }) => receiptDigest === containerDigest);
  if (
    !receipt ||
    receipt.schemaVersion !== "mission-control-image-provenance-receipt-v1" ||
    receipt.ociManifestDigest !== containerDigest ||
    !/^sha256:[a-f0-9]{64}$/.test(receipt.ociPlatformManifestDigest) ||
    !/^sha256:[a-f0-9]{64}$/.test(receipt.ociImageConfigurationDigest) ||
    receipt.signingKeyArn !== expected.deploymentAttestationKeyArn ||
    receipt.embeddedProvenanceVerified !== true
  )
    throw new Error(`Container digest ${containerDigest} lacks approved image provenance.`);
  validateBuildProvenance(receipt.provenance);
  if (
    receipt.provenance.buildMode !== "production" ||
    receipt.provenance.sourceState !== "clean" ||
    receipt.provenance.sourceCommit !== expected.applicationCommit ||
    buildIdentityDigest(receipt.provenance) !== receipt.buildIdentityDigest
  )
    throw new Error(`Container digest ${containerDigest} has contradictory build provenance.`);
  const receiptPayload = { ...receipt };
  delete receiptPayload.attestationRequest;
  delete receiptPayload.signature;
  if (
    receipt.attestationRequest?.kind !== "image-provenance" ||
    canonicalJson(receipt.attestationRequest.evidence) !== canonicalJson(receiptPayload) ||
    receipt.attestationRequest.bootstrapManifestDigest !== expected.bootstrapManifestDigest
  )
    throw new Error(`Container digest ${containerDigest} has a malformed provenance attestation envelope.`);
  const receiptVerification = await aws([
    "kms",
    "verify",
    "--key-id",
    expected.deploymentAttestationKeyArn,
    "--message-type",
    "RAW",
    "--signing-algorithm",
    "ED25519_SHA_512",
    "--message",
    Buffer.from(canonicalJson(receipt.attestationRequest), "utf8").toString("base64"),
    "--signature",
    receipt.signature,
  ]);
  if (receiptVerification.SignatureValid !== true || receiptVerification.KeyId !== expected.deploymentAttestationKeyArn)
    throw new Error(`Container digest ${containerDigest} has an invalid provenance signature.`);
}
const environment = Object.fromEntries((web.environment ?? []).map(({ name, value }) => [name, value]));
const now = new Date();
const evidence = {
  schemaVersion: "mission-control-ecs-control-plane-evidence-v1",
  observedAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
  awsAccountId: caller.Account,
  callerArn: caller.Arn,
  region: options.region,
  clusterArn: service.clusterArn,
  serviceArn: service.serviceArn,
  deploymentId: service.deployments?.find(({ status }) => status === "PRIMARY")?.id,
  taskDefinitionArn: task.taskDefinitionArn,
  taskArn: task.taskArn,
  desiredCount: service.desiredCount,
  runningCount: service.runningCount,
  pendingCount: service.pendingCount,
  deploymentCount: service.deployments.length,
  primaryRolloutState: primaryDeployments[0].rolloutState,
  taskLastStatus: task.lastStatus,
  taskHealthStatus: task.healthStatus,
  targetHealth: matchingTargets[0].TargetHealth.State,
  runningTaskArns: taskResult.taskArns,
  ecrRepositoryArn: `arn:aws:ecr:${options.region}:${caller.Account}:repository/${repositoryName}`,
  imageDigest,
  containers,
  taskRoleArn: taskDefinition.taskRoleArn,
  executionRoleArn: taskDefinition.executionRoleArn,
  configurationDigest: environment.MC_V1_PRODUCTION_CONFIGURATION_DIGEST,
  applicationCommit: environment.MC_V1_APPLICATION_COMMIT,
  buildIdentityDigest: environment.MC_V1_BUILD_IDENTITY_DIGEST,
  bootstrapManifestDigest: environment.MC_V1_STAGING_BOOTSTRAP_MANIFEST_DIGEST,
};
validateEcsControlPlaneIdentity(evidence, expected);
const contradictions = Object.entries(expected).filter(
  ([key, value]) =>
    ![
      "maximumEvidenceAgeMs",
      "deploymentAttestationKeyArn",
      "missionAgentReleaseKeyArn",
      "stagingRunId",
      "signerFunctionArn",
    ].includes(key) && canonicalJson(evidence[key]) !== canonicalJson(value),
);
if (contradictions.length)
  throw new Error(`ECS control-plane evidence contradicts expected identity: ${contradictions[0][0]}.`);
const canonicalEvidence = canonicalJson(evidence);
const evidenceChecksum = sha256(canonicalEvidence);
const attestationRequest = {
  schemaVersion: "mission-control-v1-staging-attestation-request/1",
  kind: "runtime-evidence",
  runId: expected.stagingRunId,
  accountId: expected.awsAccountId,
  region: options.region,
  bootstrapManifestDigest: expected.bootstrapManifestDigest,
  observedAt: evidence.observedAt,
  expiresAt: evidence.expiresAt,
  nonce: randomUUID(),
  sequence: 4,
  evidence,
};
const scratch = await mkdtemp(join(tmpdir(), "mission-control-v1-attestation-"));
const responsePath = join(scratch, "response.json");
let signResult;
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
    options["signer-function"],
    "--cli-binary-format",
    "raw-in-base64-out",
    "--payload",
    canonicalJson({ canonicalEnvelope: canonicalJson(attestationRequest) }),
    responsePath,
    "--output",
    "json",
  ]);
  if (JSON.parse(invocation.stdout).FunctionError)
    throw new Error("Staging attestation signer rejected runtime evidence.");
  signResult = JSON.parse(await readFile(responsePath, "utf8"));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
const verifyResult = await aws([
  "kms",
  "verify",
  "--key-id",
  expected.deploymentAttestationKeyArn,
  "--message-type",
  "RAW",
  "--signing-algorithm",
  "ED25519_SHA_512",
  "--message",
  Buffer.from(canonicalJson(attestationRequest), "utf8").toString("base64"),
  "--signature",
  signResult.signature,
]);
if (verifyResult.SignatureValid !== true) throw new Error("Deployment-attestation signature did not verify.");
if (
  signResult.keyId !== expected.deploymentAttestationKeyArn ||
  verifyResult.KeyId !== expected.deploymentAttestationKeyArn
)
  throw new Error("KMS response used an unapproved deployment-attestation key.");
const receipt = {
  evidence,
  evidenceChecksum,
  attestationRequest,
  signature: signResult.signature,
  signingKeyId: signResult.keyId,
  signingAlgorithm: signResult.signingAlgorithm,
  signatureVerified: true,
};
await writeFile(options.output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ output: options.output, evidenceChecksum })}\n`);
