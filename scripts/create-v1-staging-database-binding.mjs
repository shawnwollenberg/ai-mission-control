import { execFile } from "node:child_process";
import { createPublicKey, randomUUID, verify } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { canonicalJson, sha256 } from "../application/v1-production-runtime-identity.ts";
import { assertV1StagingBootstrapManifestDigest } from "../application/v1-staging-bootstrap-manifest.ts";
import { databaseAuthorityFromUrl } from "../lib/v1-staging-database-binding.ts";

const exec = promisify(execFile);
const options = parseArgs({
  options: {
    profile: { type: "string" },
    region: { type: "string" },
    manifest: { type: "string" },
    "manifest-digest": { type: "string" },
    "signer-function": { type: "string" },
    "kms-key-id": { type: "string" },
    output: { type: "string" },
  },
  strict: true,
}).values;
for (const name of ["profile", "region", "manifest", "manifest-digest", "signer-function", "kms-key-id", "output"])
  if (!options[name]) throw new Error(`--${name} is required.`);
const manifest = JSON.parse(await readFile(options.manifest, "utf8"));
assertV1StagingBootstrapManifestDigest(manifest, options["manifest-digest"]);
const runtimeSecrets = manifest.resources.secrets.filter(
  ({ name }) => name === `mission-control-v1-staging-${manifest.runId}-runtime`,
);
const runtimeSecretArn = runtimeSecrets[0]?.arn;
if (
  manifest.region !== options.region ||
  manifest.resources.kmsKey.arn !== options["kms-key-id"] ||
  runtimeSecrets.length !== 1 ||
  !runtimeSecretArn
)
  throw new Error("Database binding inputs contradict the exact bootstrap manifest.");
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
const database = (
  await aws(["rds", "describe-db-instances", "--db-instance-identifier", manifest.resources.database.id])
).DBInstances?.[0];
if (
  !database ||
  database.DBInstanceArn !== manifest.resources.database.arn ||
  database.Endpoint?.Address !== manifest.resources.database.endpoint ||
  database.Endpoint?.Port !== manifest.resources.database.port ||
  database.DBName !== manifest.resources.database.databaseName ||
  database.DBInstanceStatus !== "available"
)
  throw new Error("Live RDS control-plane evidence contradicts the bootstrap manifest.");
const secretResult = await aws(["secretsmanager", "get-secret-value", "--secret-id", runtimeSecretArn]);
const secret = JSON.parse(secretResult.SecretString);
const runtime = databaseAuthorityFromUrl(secret.databaseUrl);
const controller = databaseAuthorityFromUrl(secret.controllerDatabaseUrl);
const observedAt = new Date();
const unsigned = {
  schemaVersion: "mission-control-v1-staging-database-binding/1",
  runId: manifest.runId,
  bootstrapManifestDigest: options["manifest-digest"],
  observedAt: observedAt.toISOString(),
  expiresAt: new Date(observedAt.getTime() + 2 * 60 * 60_000).toISOString(),
  accountId: manifest.accountId,
  region: manifest.region,
  rdsArn: database.DBInstanceArn,
  resourceId: database.DBInstanceIdentifier,
  endpoint: database.Endpoint.Address,
  port: database.Endpoint.Port,
  databaseName: database.DBName,
  caIdentifier: database.CACertificateIdentifier,
  schemaCompatibility: { minimum: "0028", maximum: "0030" },
  runtime,
  controller,
};
const request = {
  schemaVersion: "mission-control-v1-staging-attestation-request/1",
  kind: "database-binding",
  runId: manifest.runId,
  accountId: manifest.accountId,
  region: manifest.region,
  bootstrapManifestDigest: options["manifest-digest"],
  observedAt: unsigned.observedAt,
  expiresAt: new Date(observedAt.getTime() + 5 * 60_000).toISOString(),
  nonce: randomUUID(),
  sequence: 3,
  evidence: unsigned,
};
const scratch = await mkdtemp(join(tmpdir(), "mission-control-v1-database-binding-"));
const responsePath = join(scratch, "signer-response.json");
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
    options["signer-function"],
    "--cli-binary-format",
    "raw-in-base64-out",
    "--payload",
    canonicalJson({ canonicalEnvelope: canonicalJson(request) }),
    responsePath,
    "--output",
    "json",
  ]);
  if (JSON.parse(invocation.stdout).FunctionError) throw new Error("Signer rejected database binding.");
  signed = JSON.parse(await readFile(responsePath, "utf8"));
  const publicResult = await aws(["kms", "get-public-key", "--key-id", options["kms-key-id"]]);
  const publicKey = createPublicKey({
    key: Buffer.from(publicResult.PublicKey, "base64"),
    type: "spki",
    format: "der",
  });
  if (
    signed.keyId !== options["kms-key-id"] ||
    !verify(
      null,
      new Uint8Array(Buffer.from(canonicalJson(request))),
      publicKey,
      new Uint8Array(Buffer.from(signed.signature, "base64")),
    )
  )
    throw new Error("Database binding signature did not verify independently.");
  const receipt = { ...unsigned, attestationRequest: request, signature: signed.signature };
  secret.databaseBindingReceipt = canonicalJson(receipt);
  secret.attestationPublicKey = publicResult.PublicKey;
  const secretPath = join(scratch, "runtime-secret.json");
  await writeFile(secretPath, canonicalJson(secret), { mode: 0o600 });
  await exec("aws", [
    "--profile",
    options.profile,
    "--region",
    options.region,
    "--no-cli-pager",
    "secretsmanager",
    "put-secret-value",
    "--secret-id",
    runtimeSecretArn,
    "--secret-string",
    `file://${secretPath}`,
    "--output",
    "json",
  ]);
  await writeFile(options.output, `${canonicalJson(receipt)}\n`, { mode: 0o600, flag: "wx" });
  process.stdout.write(
    `${JSON.stringify({ output: options.output, receiptDigest: sha256(canonicalJson(receipt)), rdsArn: database.DBInstanceArn })}\n`,
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
