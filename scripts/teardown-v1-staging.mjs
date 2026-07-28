import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs, promisify } from "node:util";
import { assertV1StagingBootstrapManifestDigest } from "../application/v1-staging-bootstrap-manifest.ts";

const exec = promisify(execFile);
const options = parseArgs({
  options: {
    profile: { type: "string" },
    "authority-profile": { type: "string" },
    region: { type: "string" },
    manifest: { type: "string" },
    "manifest-digest": { type: "string" },
    "certificate-receipt": { type: "string" },
    output: { type: "string" },
  },
  strict: true,
}).values;
for (const name of [
  "profile",
  "authority-profile",
  "region",
  "manifest",
  "manifest-digest",
  "certificate-receipt",
  "output",
])
  if (!options[name]) throw new Error(`--${name} is required.`);
const manifest = JSON.parse(await readFile(options.manifest, "utf8"));
assertV1StagingBootstrapManifestDigest(manifest, options["manifest-digest"]);
const certificate = JSON.parse(await readFile(options["certificate-receipt"], "utf8"));
const prefix = `mission-control-v1-staging-${manifest.runId}`;
if (
  options.region !== manifest.region ||
  certificate.runId !== manifest.runId ||
  certificate.certificateArn !== manifest.resources.certificate.arn
)
  throw new Error("Teardown inputs contradict the exact staging run.");
const awsRaw = (profile, args) =>
  exec("aws", ["--profile", profile, "--region", options.region, "--no-cli-pager", ...args, "--output", "json"]);
const deleteStack = async (name, profile = options.profile) => {
  let status;
  try {
    status = JSON.parse((await awsRaw(profile, ["cloudformation", "describe-stacks", "--stack-name", name])).stdout)
      .Stacks?.[0]?.StackStatus;
  } catch (error) {
    if (String(error?.stderr).includes("does not exist")) return;
    throw error;
  }
  if (status !== "DELETE_IN_PROGRESS") await awsRaw(profile, ["cloudformation", "delete-stack", "--stack-name", name]);
  await exec("aws", [
    "--profile",
    profile,
    "--region",
    options.region,
    "--no-cli-pager",
    "cloudformation",
    "wait",
    "stack-delete-complete",
    "--stack-name",
    name,
  ]);
};
const deletedStacks = [];
const runtimeStack = `${prefix}-runtime`;
await deleteStack(runtimeStack);
deletedStacks.push(runtimeStack);
for (;;) {
  let page;
  try {
    page = JSON.parse(
      (
        await awsRaw(options.profile, [
          "s3api",
          "list-object-versions",
          "--bucket",
          manifest.resources.evidenceBucket.id,
        ])
      ).stdout,
    );
  } catch (error) {
    if (String(error?.stderr).includes("NoSuchBucket")) break;
    throw error;
  }
  const objects = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].map(({ Key, VersionId }) => ({
    Key,
    VersionId,
  }));
  if (!objects.length) break;
  await awsRaw(options.profile, [
    "s3api",
    "delete-objects",
    "--bucket",
    manifest.resources.evidenceBucket.id,
    "--delete",
    JSON.stringify({ Objects: objects, Quiet: true }),
  ]);
  if (!page.IsTruncated) break;
}
const bootstrapStack = `${prefix}-bootstrap`;
await deleteStack(bootstrapStack);
deletedStacks.push(bootstrapStack);
try {
  await awsRaw(options.profile, ["acm", "delete-certificate", "--certificate-arn", certificate.certificateArn]);
} catch (error) {
  if (!String(error?.stderr).includes("ResourceNotFoundException")) throw error;
}
const deploymentStack = `${prefix}-deployment`;
await deleteStack(deploymentStack, options["authority-profile"]);
deletedStacks.push(deploymentStack);
const authorityStack = `${prefix}-authority`;
await deleteStack(authorityStack, options["authority-profile"]);
deletedStacks.push(authorityStack);
const key = JSON.parse(
  (await awsRaw(options["authority-profile"], ["kms", "describe-key", "--key-id", manifest.resources.kmsKey.arn]))
    .stdout,
).KeyMetadata;
if (key.KeyState !== "PendingDeletion") throw new Error("Disposable staging attestation key is not pending deletion.");
const remaining = JSON.parse(
  (
    await awsRaw(options["authority-profile"], [
      "resourcegroupstaggingapi",
      "get-resources",
      "--tag-filters",
      `Key=StagingRunId,Values=${manifest.runId}`,
    ])
  ).stdout,
).ResourceTagMappingList;
const inactiveEcsHistory = [];
const serviceArn = `arn:aws:ecs:${manifest.region}:${manifest.accountId}:service/${prefix}-cluster/${prefix}-service`;
for (const { ResourceARN } of remaining ?? []) {
  if (ResourceARN.startsWith(`arn:aws:ecs:${manifest.region}:${manifest.accountId}:task-definition/${prefix}-`)) {
    const taskDefinition = JSON.parse(
      (
        await awsRaw(options["authority-profile"], [
          "ecs",
          "describe-task-definition",
          "--task-definition",
          ResourceARN,
        ])
      ).stdout,
    ).taskDefinition;
    if (taskDefinition?.status !== "INACTIVE")
      throw new Error(`Run-scoped task definition remains active: ${ResourceARN}.`);
    inactiveEcsHistory.push(ResourceARN);
  }
}
const terminalEcsControlPlaneHistory = [];
if ((remaining ?? []).some(({ ResourceARN }) => ResourceARN === manifest.resources.ecsCluster.arn)) {
  const cluster = JSON.parse(
    (
      await awsRaw(options["authority-profile"], [
        "ecs",
        "describe-clusters",
        "--clusters",
        manifest.resources.ecsCluster.arn,
      ])
    ).stdout,
  ).clusters?.[0];
  if (
    cluster?.status !== "INACTIVE" ||
    cluster.activeServicesCount !== 0 ||
    cluster.runningTasksCount !== 0 ||
    cluster.pendingTasksCount !== 0
  )
    throw new Error("Run-scoped ECS cluster is not terminal and empty.");
  terminalEcsControlPlaneHistory.push(manifest.resources.ecsCluster.arn);
}
if ((remaining ?? []).some(({ ResourceARN }) => ResourceARN === serviceArn)) {
  const service = JSON.parse(
    (
      await awsRaw(options["authority-profile"], [
        "ecs",
        "describe-services",
        "--cluster",
        manifest.resources.ecsCluster.arn,
        "--services",
        serviceArn,
      ])
    ).stdout,
  ).services?.[0];
  if (service?.status !== "INACTIVE") throw new Error("Run-scoped ECS service is not terminal.");
  terminalEcsControlPlaneHistory.push(serviceArn);
}
const unexpected = (remaining ?? []).filter(
  ({ ResourceARN }) =>
    ResourceARN !== manifest.resources.kmsKey.arn &&
    !inactiveEcsHistory.includes(ResourceARN) &&
    !terminalEcsControlPlaneHistory.includes(ResourceARN),
);
if (unexpected.length) throw new Error(`Unexpected run-tagged resources remain after teardown: ${unexpected.length}.`);
const evidence = {
  schemaVersion: "mission-control-v1-staging-teardown/1",
  runId: manifest.runId,
  deletedStacks,
  certificateDeleted: certificate.certificateArn,
  kmsKeyArn: manifest.resources.kmsKey.arn,
  kmsKeyState: key.KeyState,
  kmsDeletionDate: key.DeletionDate,
  inactiveEcsHistory,
  terminalEcsControlPlaneHistory,
  remainingRunTaggedResources: (remaining ?? []).map(({ ResourceARN }) => ResourceARN),
  productionResourcesInspected: false,
  productionResourcesModified: false,
};
const canonical = JSON.stringify(evidence);
const checksum = createHash("sha256").update(canonical).digest("hex");
await writeFile(options.output, `${JSON.stringify({ ...evidence, checksum }, null, 2)}\n`, {
  mode: 0o600,
  flag: "wx",
});
process.stdout.write(`${JSON.stringify({ output: options.output, checksum, kmsKeyState: key.KeyState })}\n`);
