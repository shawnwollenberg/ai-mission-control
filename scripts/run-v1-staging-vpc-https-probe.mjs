import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs, promisify } from "node:util";
import { assertV1StagingBootstrapManifestDigest } from "../application/v1-staging-bootstrap-manifest.ts";

const exec = promisify(execFile);
const options = parseArgs({
  options: {
    profile: { type: "string" },
    region: { type: "string" },
    manifest: { type: "string" },
    "manifest-digest": { type: "string" },
    "task-definition": { type: "string" },
    output: { type: "string" },
  },
  strict: true,
}).values;
for (const name of ["profile", "region", "manifest", "manifest-digest", "task-definition", "output"])
  if (!options[name]) throw new Error(`--${name} is required.`);
const manifest = JSON.parse(await readFile(options.manifest, "utf8"));
assertV1StagingBootstrapManifestDigest(manifest, options["manifest-digest"]);
const prefix = `mission-control-v1-staging-${manifest.runId}`;
if (
  options.region !== manifest.region ||
  !new RegExp(`^arn:aws:ecs:${options.region}:${manifest.accountId}:task-definition/${prefix}-https-probe:\\d+$`).test(
    options["task-definition"],
  )
)
  throw new Error("VPC HTTPS probe inputs contradict the exact staging run.");
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
const taskSecurityGroup = manifest.resources.securityGroups.find(({ name }) => name === `${prefix}-task-sg`);
if (!taskSecurityGroup) throw new Error("Exact staging task security group is absent.");
const started = await aws([
  "ecs",
  "run-task",
  "--cluster",
  manifest.resources.ecsCluster.arn,
  "--task-definition",
  options["task-definition"],
  "--launch-type",
  "FARGATE",
  "--network-configuration",
  `awsvpcConfiguration={subnets=[${manifest.resources.subnets.map(({ id }) => id).join(",")}],securityGroups=[${taskSecurityGroup.id}],assignPublicIp=ENABLED}`,
  "--count",
  "1",
  "--started-by",
  `v1-https-probe-${manifest.runId}`,
]);
if (started.failures?.length || started.tasks?.length !== 1)
  throw new Error("Disposable VPC HTTPS probe did not start.");
const taskArn = started.tasks[0].taskArn;
await exec("aws", [
  "--profile",
  options.profile,
  "--region",
  options.region,
  "--no-cli-pager",
  "ecs",
  "wait",
  "tasks-stopped",
  "--cluster",
  manifest.resources.ecsCluster.arn,
  "--tasks",
  taskArn,
]);
const task = (await aws(["ecs", "describe-tasks", "--cluster", manifest.resources.ecsCluster.arn, "--tasks", taskArn]))
  .tasks?.[0];
const container = task?.containers?.find(({ name }) => name === "https-probe");
if (!task || task.lastStatus !== "STOPPED" || container?.exitCode !== 0)
  throw new Error(`VPC HTTPS probe failed: ${container?.reason ?? task?.stoppedReason ?? "unknown"}.`);
const taskId = taskArn.split("/").at(-1);
const logs = await aws([
  "logs",
  "get-log-events",
  "--log-group-name",
  manifest.resources.logGroup.id,
  "--log-stream-name",
  `https-probe/https-probe/${taskId}`,
  "--start-from-head",
]);
const messages = (logs.events ?? []).map(({ message }) => message);
const probeEvidence = messages
  .map((message) => {
    try {
      return JSON.parse(message);
    } catch {
      return undefined;
    }
  })
  .find(({ event } = {}) => event === "v1_vpc_https_leaf_pin_reachability_probe");
if (
  !probeEvidence ||
  probeEvidence.tlsAuthority !== "leaf-der-sha256-pin-only" ||
  probeEvidence.satisfiesIndependentTlsAcceptance !== false ||
  !Array.isArray(probeEvidence.results) ||
  probeEvidence.results.length !== 2
)
  throw new Error("VPC HTTPS probe emitted no canonical success evidence.");
const evidence = {
  schemaVersion: "mission-control-v1-staging-vpc-https-probe/1",
  runId: manifest.runId,
  clusterArn: manifest.resources.ecsCluster.arn,
  taskDefinitionArn: task.taskDefinitionArn,
  taskArn,
  startedAt: task.createdAt,
  stoppedAt: task.stoppedAt,
  exitCode: container.exitCode,
  tlsAuthority: probeEvidence.tlsAuthority,
  satisfiesIndependentTlsAcceptance: probeEvidence.satisfiesIndependentTlsAcceptance,
  results: probeEvidence.results,
  logMessages: messages,
};
await writeFile(options.output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: "wx" });
process.stdout.write(`${JSON.stringify({ output: options.output, taskArn, exitCode: 0 })}\n`);
