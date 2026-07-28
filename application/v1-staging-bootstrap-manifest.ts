import { createHash } from "node:crypto";
import { canonicalJson } from "./v1-production-runtime-identity";

const SHA256 = /^[a-f0-9]{64}$/;
const RUN_ID = /^[a-z0-9][a-z0-9-]{7,15}$/;
const ACCOUNT = /^\d{12}$/;
const REGION = /^[a-z]{2}-[a-z]+-\d$/;
const requiredTags = {
  Environment: "staging",
  Project: "mission-control",
  Purpose: "v1-external-acceptance",
  Disposable: "true",
  ProductionAccess: "false",
} as const;

export type V1StagingResourceIdentity = {
  kind: string;
  name: string;
  id: string;
  arn?: string;
  createdAt: string;
  tags: Record<string, string>;
};

export type V1StagingBootstrapManifest = {
  schemaVersion: "mission-control-v1-staging-bootstrap-manifest/1";
  runId: string;
  accountId: string;
  region: string;
  observedAt: string;
  expiresAt: string;
  expectedConsumers: ["runtime-deployer", "database-binding-verifier", "attestation-signer"];
  resources: {
    vpc: V1StagingResourceIdentity;
    subnets: (V1StagingResourceIdentity & { availabilityZone: string })[];
    routeTables: V1StagingResourceIdentity[];
    securityGroups: V1StagingResourceIdentity[];
    ecsCluster: V1StagingResourceIdentity;
    ecrRepositories: V1StagingResourceIdentity[];
    database: V1StagingResourceIdentity & { endpoint: string; port: number; databaseName: string };
    kmsKey: V1StagingResourceIdentity;
    evidenceBucket: V1StagingResourceIdentity;
    secrets: V1StagingResourceIdentity[];
    certificate: V1StagingResourceIdentity & { domainName: string };
    loadBalancer: V1StagingResourceIdentity & { dnsName: string; scheme: "internet-facing" };
    targetGroup: V1StagingResourceIdentity;
    logGroup: V1StagingResourceIdentity;
    iamRoles: V1StagingResourceIdentity[];
  };
};

function validateResource(
  resource: V1StagingResourceIdentity,
  manifest: Pick<V1StagingBootstrapManifest, "runId" | "accountId" | "region" | "observedAt">,
): void {
  if (
    !resource?.kind ||
    !resource.name ||
    !resource.id ||
    !Number.isFinite(Date.parse(resource.createdAt)) ||
    Date.parse(resource.createdAt) > Date.parse(manifest.observedAt)
  )
    throw new Error("Staging bootstrap resource identity is malformed, stale, or not run-bound.");
  for (const [key, value] of Object.entries(requiredTags))
    if (resource.tags?.[key] !== value || resource.tags.StagingRunId !== manifest.runId)
      throw new Error("Staging bootstrap resource lacks the exact run tags.");
  if (resource.arn) {
    const isS3 = resource.arn.startsWith("arn:aws:s3:::");
    const isGlobalIam = resource.arn.startsWith(`arn:aws:iam::${manifest.accountId}:`);
    const isRegional =
      resource.arn.includes(`:${manifest.region}:${manifest.accountId}:`) ||
      resource.arn.startsWith(`arn:aws:elasticloadbalancing:${manifest.region}:${manifest.accountId}:`);
    if ((!isS3 && !isGlobalIam && !isRegional) || (isS3 && !resource.arn.endsWith(resource.id)))
      throw new Error("Staging bootstrap resource belongs to another account or region.");
  }
}

export function validateV1StagingBootstrapManifest(manifest: V1StagingBootstrapManifest, now = Date.now()): void {
  if (
    manifest.schemaVersion !== "mission-control-v1-staging-bootstrap-manifest/1" ||
    !RUN_ID.test(manifest.runId) ||
    !ACCOUNT.test(manifest.accountId) ||
    !REGION.test(manifest.region) ||
    !Number.isFinite(Date.parse(manifest.observedAt)) ||
    !Number.isFinite(Date.parse(manifest.expiresAt)) ||
    Date.parse(manifest.observedAt) > now + 60_000 ||
    Date.parse(manifest.expiresAt) <= now ||
    canonicalJson(manifest.expectedConsumers) !==
      canonicalJson(["runtime-deployer", "database-binding-verifier", "attestation-signer"])
  )
    throw new Error("Staging bootstrap manifest is malformed or stale.");
  const resources = manifest.resources;
  const single = [
    resources.vpc,
    resources.ecsCluster,
    resources.database,
    resources.kmsKey,
    resources.evidenceBucket,
    resources.certificate,
    resources.loadBalancer,
    resources.targetGroup,
    resources.logGroup,
  ];
  const collections = [
    resources.subnets,
    resources.routeTables,
    resources.securityGroups,
    resources.ecrRepositories,
    resources.secrets,
    resources.iamRoles,
  ];
  if (single.some((resource) => !resource) || collections.some((entries) => !Array.isArray(entries) || !entries.length))
    throw new Error("Staging bootstrap manifest is incomplete.");
  for (const resource of [...single, ...collections.flat()]) validateResource(resource, manifest);
  const prefix = `mission-control-v1-staging-${manifest.runId}`;
  const exactNames = (entries: V1StagingResourceIdentity[], expected: string[]) =>
    canonicalJson(entries.map(({ name }) => name).sort()) === canonicalJson([...expected].sort());
  if (
    resources.vpc.kind !== "vpc" ||
    resources.subnets.length !== 2 ||
    resources.subnets.some(
      ({ kind, availabilityZone }) => kind !== "subnet" || !availabilityZone.startsWith(manifest.region),
    ) ||
    new Set(resources.subnets.map(({ id }) => id)).size !== 2 ||
    resources.routeTables.length !== 2 ||
    resources.routeTables.some(({ kind }) => kind !== "route-table") ||
    resources.securityGroups.length !== 3 ||
    !exactNames(resources.securityGroups, [`${prefix}-database-sg`, `${prefix}-task-sg`, `${prefix}-alb-sg`]) ||
    resources.ecrRepositories.length !== 1 ||
    resources.ecrRepositories[0].kind !== "ecr-repository" ||
    resources.ecrRepositories[0].id !== prefix ||
    resources.secrets.length !== 2 ||
    !exactNames(resources.secrets, [`${prefix}-database-admin`, `${prefix}-runtime`]) ||
    resources.iamRoles.length !== 4 ||
    !exactNames(resources.iamRoles, [
      `${prefix}-task`,
      `${prefix}-execution`,
      `${prefix}-probe`,
      `${prefix}-collector`,
    ]) ||
    resources.ecsCluster.kind !== "ecs-cluster" ||
    resources.database.kind !== "rds-instance" ||
    resources.kmsKey.kind !== "kms-key" ||
    resources.evidenceBucket.kind !== "s3-bucket" ||
    resources.certificate.kind !== "certificate" ||
    resources.loadBalancer.kind !== "load-balancer" ||
    resources.loadBalancer.scheme !== "internet-facing" ||
    !resources.loadBalancer.dnsName.endsWith(`.${manifest.region}.elb.amazonaws.com`) ||
    resources.targetGroup.kind !== "target-group" ||
    resources.logGroup.kind !== "log-group"
  )
    throw new Error("Staging bootstrap manifest resource topology is not exact.");
  if (
    !resources.database.arn ||
    !resources.database.endpoint.endsWith(`.${manifest.region}.rds.amazonaws.com`) ||
    resources.database.port !== 5432 ||
    resources.database.databaseName !== `mission_control_v1_staging_${manifest.runId.replaceAll("-", "_")}`
  )
    throw new Error("Staging database identity is not canonical.");
  if (resources.certificate.domainName !== `*.${manifest.region}.elb.amazonaws.com`)
    throw new Error("Staging certificate does not cover the native regional ALB hostname.");
}

export function v1StagingBootstrapManifestDigest(manifest: V1StagingBootstrapManifest, now = Date.now()): string {
  validateV1StagingBootstrapManifest(manifest, now);
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}

export function assertV1StagingBootstrapManifestDigest(
  manifest: V1StagingBootstrapManifest,
  expectedDigest: string,
  now = Date.now(),
): void {
  if (!SHA256.test(expectedDigest) || v1StagingBootstrapManifestDigest(manifest, now) !== expectedDigest)
    throw new Error("Staging bootstrap manifest digest does not match the reviewed deployment input.");
}
