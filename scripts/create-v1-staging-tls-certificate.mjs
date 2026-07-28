import { execFile } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";

const exec = promisify(execFile);
const options = parseArgs({
  options: {
    profile: { type: "string" },
    region: { type: "string" },
    "run-id": { type: "string" },
    output: { type: "string" },
    "certificate-output": { type: "string" },
  },
  strict: true,
}).values;
for (const name of ["profile", "region", "run-id", "output", "certificate-output"])
  if (!options[name]) throw new Error(`--${name} is required.`);
if (!/^[a-z0-9][a-z0-9-]{7,15}$/.test(options["run-id"]) || options.region !== "us-east-1")
  throw new Error("Temporary TLS certificate requires the exact disposable run and region.");

const scratch = await mkdtemp(join(tmpdir(), "mission-control-v1-tls-"));
const privateKey = join(scratch, "private-key.pem");
const certificate = join(scratch, "certificate.pem");
const config = join(scratch, "openssl.cnf");
try {
  const domainName = `*.${options.region}.elb.amazonaws.com`;
  await writeFile(
    config,
    `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=${domainName}\nO=Mission Control Disposable Staging\n[ext]\nsubjectAltName=DNS:${domainName}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`,
    { mode: 0o600 },
  );
  await exec("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-nodes",
    "-days",
    "2",
    "-keyout",
    privateKey,
    "-out",
    certificate,
    "-config",
    config,
  ]);
  const tags = {
    Environment: "staging",
    Project: "mission-control",
    Purpose: "v1-external-acceptance",
    Disposable: "true",
    ProductionAccess: "false",
    StagingRunId: options["run-id"],
  };
  const imported = JSON.parse(
    (
      await exec("aws", [
        "--profile",
        options.profile,
        "--region",
        options.region,
        "--no-cli-pager",
        "acm",
        "import-certificate",
        "--certificate",
        `fileb://${certificate}`,
        "--private-key",
        `fileb://${privateKey}`,
        "--tags",
        ...Object.entries(tags).map(([Key, Value]) => `Key=${Key},Value=${Value}`),
        "--output",
        "json",
      ])
    ).stdout,
  );
  const described = JSON.parse(
    (
      await exec("aws", [
        "--profile",
        options.profile,
        "--region",
        options.region,
        "--no-cli-pager",
        "acm",
        "describe-certificate",
        "--certificate-arn",
        imported.CertificateArn,
        "--output",
        "json",
      ])
    ).stdout,
  ).Certificate;
  if (
    described?.DomainName !== domainName ||
    described.Status !== "ISSUED" ||
    described.Type !== "IMPORTED" ||
    described.InUseBy?.length
  )
    throw new Error("Imported staging certificate identity is contradictory.");
  const publicBytes = await readFile(certificate);
  const parsedCertificate = new X509Certificate(publicBytes);
  await writeFile(options["certificate-output"], publicBytes, { mode: 0o600, flag: "wx" });
  const receipt = {
    schemaVersion: "mission-control-v1-staging-tls-certificate/1",
    runId: options["run-id"],
    region: options.region,
    certificateArn: imported.CertificateArn,
    domainName,
    certificateSha256: createHash("sha256").update(publicBytes).digest("hex"),
    certificateDerSha256: createHash("sha256").update(parsedCertificate.raw).digest("hex"),
    notBefore: described.NotBefore,
    notAfter: described.NotAfter,
    tags,
  };
  await writeFile(options.output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  process.stdout.write(
    `${JSON.stringify({ output: options.output, certificateArn: imported.CertificateArn, certificateSha256: receipt.certificateSha256 })}\n`,
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
