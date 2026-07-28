import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { parseArgs, promisify } from "node:util";
import { canonicalJson, sha256 } from "../application/v1-production-runtime-identity.ts";
import { validateV1StagingBootstrapManifest } from "../application/v1-staging-bootstrap-manifest.ts";

const exec = promisify(execFile);
const options = parseArgs({
  options: {
    profile: { type: "string" },
    region: { type: "string" },
    stack: { type: "string" },
    "run-id": { type: "string" },
    output: { type: "string" },
  },
  strict: true,
}).values;
for (const name of ["profile", "region", "stack", "run-id", "output"])
  if (!options[name]) throw new Error(`--${name} is required.`);
const runId = options["run-id"];
const prefix = `mission-control-v1-staging-${runId}`;
if (options.stack !== `${prefix}-bootstrap`) throw new Error("Bootstrap stack name is not run-bound.");
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
const caller = await aws(["sts", "get-caller-identity"]);
const stack = (await aws(["cloudformation", "describe-stacks", "--stack-name", options.stack])).Stacks?.[0];
if (!stack || !["CREATE_COMPLETE", "UPDATE_COMPLETE"].includes(stack.StackStatus))
  throw new Error("Exact staging bootstrap stack is not complete.");
const outputs = Object.fromEntries(stack.Outputs.map(({ OutputKey, OutputValue }) => [OutputKey, OutputValue]));
const requiredStackTags = {
  Environment: "staging",
  Project: "mission-control",
  Purpose: "v1-external-acceptance",
  Disposable: "true",
  ProductionAccess: "false",
  StagingRunId: runId,
};
const stackTags = Object.fromEntries(stack.Tags.map(({ Key, Value }) => [Key, Value]));
for (const [key, value] of Object.entries(requiredStackTags))
  if (stackTags[key] !== value) throw new Error("Bootstrap stack lacks the exact staging run tags.");
const tagResult = await aws([
  "resourcegroupstaggingapi",
  "get-resources",
  "--tag-filters",
  `Key=StagingRunId,Values=${runId}`,
]);
const tagMap = new Map(
  (tagResult.ResourceTagMappingList ?? []).map(({ ResourceARN, Tags }) => [
    ResourceARN,
    Object.fromEntries(Tags.map(({ Key, Value }) => [Key, Value])),
  ]),
);
const stackResources = (await aws(["cloudformation", "list-stack-resources", "--stack-name", options.stack]))
  .StackResourceSummaries;
const updatedAt = new Map(
  stackResources.map(({ PhysicalResourceId, LastUpdatedTimestamp }) => [PhysicalResourceId, LastUpdatedTimestamp]),
);
const arn = {
  vpc: `arn:aws:ec2:${options.region}:${caller.Account}:vpc/${outputs.VpcId}`,
  subnets: outputs.PublicSubnetIds.split(",").map(
    (id) => `arn:aws:ec2:${options.region}:${caller.Account}:subnet/${id}`,
  ),
  routes: outputs.RouteTableIds.split(",").map(
    (id) => `arn:aws:ec2:${options.region}:${caller.Account}:route-table/${id}`,
  ),
  securityGroups: [
    outputs.DatabaseSecurityGroupId,
    outputs.TaskSecurityGroupId,
    outputs.LoadBalancerSecurityGroupId,
  ].map((id) => `arn:aws:ec2:${options.region}:${caller.Account}:security-group/${id}`),
};
const runtimeSecret = await aws(["secretsmanager", "describe-secret", "--secret-id", outputs.RuntimeSecretArn]);
const certificate = await aws(["acm", "describe-certificate", "--certificate-arn", outputs.CertificateArn]);
const created = (physicalId, fallback = stack.CreationTime) => updatedAt.get(physicalId) ?? fallback;
const identity = (kind, name, id, resourceArn, createdAt = created(id), explicitTags) => {
  const tags = explicitTags ?? tagMap.get(resourceArn);
  if (!tags) throw new Error(`Run-tagged resource is absent from the exact inventory: ${kind}.`);
  return { kind, name, id, arn: resourceArn, createdAt, tags };
};
const role = async (output, name) => {
  const roleName = outputs[output].split("/").at(-1);
  const result = await aws(["iam", "list-role-tags", "--role-name", roleName]);
  const tags = Object.fromEntries((result.Tags ?? []).map(({ Key, Value }) => [Key, Value]));
  for (const [key, value] of Object.entries(requiredStackTags))
    if (tags[key] !== value) throw new Error(`IAM role lacks the exact staging run tags: ${name}.`);
  return identity("iam-role", name, roleName, outputs[output], created(roleName), tags);
};
const iamRoles = await Promise.all([
  role("TaskRoleArn", `${prefix}-task`),
  role("ExecutionRoleArn", `${prefix}-execution`),
  role("ProbeRoleArn", `${prefix}-probe`),
  role("CollectorRoleArn", `${prefix}-collector`),
]);
const observedAt = new Date();
const manifest = {
  schemaVersion: "mission-control-v1-staging-bootstrap-manifest/1",
  runId,
  accountId: caller.Account,
  region: options.region,
  observedAt: observedAt.toISOString(),
  expiresAt: new Date(observedAt.getTime() + 2 * 60 * 60_000).toISOString(),
  expectedConsumers: ["runtime-deployer", "database-binding-verifier", "attestation-signer"],
  resources: {
    vpc: identity("vpc", `${prefix}-vpc`, outputs.VpcId, arn.vpc),
    subnets: outputs.PublicSubnetIds.split(",").map((id, index) => ({
      ...identity("subnet", `${prefix}-public-${index + 1}`, id, arn.subnets[index]),
      availabilityZone: outputs.AvailabilityZones.split(",")[index],
    })),
    routeTables: outputs.RouteTableIds.split(",").map((id, index) =>
      identity("route-table", `${prefix}-public-${index + 1}-route`, id, arn.routes[index]),
    ),
    securityGroups: [
      identity("security-group", `${prefix}-database-sg`, outputs.DatabaseSecurityGroupId, arn.securityGroups[0]),
      identity("security-group", `${prefix}-task-sg`, outputs.TaskSecurityGroupId, arn.securityGroups[1]),
      identity("security-group", `${prefix}-alb-sg`, outputs.LoadBalancerSecurityGroupId, arn.securityGroups[2]),
    ],
    ecsCluster: identity("ecs-cluster", `${prefix}-cluster`, outputs.ClusterName, outputs.ClusterArn),
    ecrRepositories: [identity("ecr-repository", prefix, outputs.RepositoryName, outputs.RepositoryArn)],
    database: {
      ...identity("rds-instance", `${prefix}-postgres`, outputs.DatabaseIdentifier, outputs.DatabaseArn),
      endpoint: outputs.DatabaseEndpoint,
      port: Number(outputs.DatabasePort),
      databaseName: outputs.DatabaseName,
    },
    kmsKey: identity(
      "kms-key",
      `${prefix}-deployment-attestation`,
      outputs.AttestationKeyArn,
      outputs.AttestationKeyArn,
    ),
    evidenceBucket: identity("s3-bucket", `${prefix}-evidence`, outputs.EvidenceBucketName, outputs.EvidenceBucketArn),
    secrets: [
      identity(
        "secret",
        `${prefix}-database-admin`,
        outputs.DatabaseSecretArn.split(":secret:")[1],
        outputs.DatabaseSecretArn,
      ),
      identity("secret", `${prefix}-runtime`, runtimeSecret.Name, runtimeSecret.ARN, runtimeSecret.CreatedDate),
    ],
    certificate: {
      ...identity(
        "certificate",
        `${prefix}-certificate`,
        outputs.CertificateArn,
        outputs.CertificateArn,
        certificate.Certificate.CreatedAt,
      ),
      domainName: certificate.Certificate.DomainName,
    },
    loadBalancer: {
      ...identity("load-balancer", `${prefix}-alb`, outputs.LoadBalancerArn, outputs.LoadBalancerArn),
      dnsName: outputs.LoadBalancerDnsName,
      scheme: "internet-facing",
    },
    targetGroup: identity("target-group", `${prefix}-target`, outputs.TargetGroupArn, outputs.TargetGroupArn),
    logGroup: identity("log-group", `${prefix}-logs`, outputs.LogGroupName, outputs.LogGroupArn.replace(/:\*$/, "")),
    iamRoles,
  },
};
validateV1StagingBootstrapManifest(manifest);
const digest = sha256(canonicalJson(manifest));
await writeFile(options.output, `${canonicalJson(manifest)}\n`, { mode: 0o600, flag: "wx" });
await writeFile(`${options.output}.sha256`, `${digest}\n`, { mode: 0o600, flag: "wx" });
process.stdout.write(`${JSON.stringify({ output: options.output, digest, runId })}\n`);
