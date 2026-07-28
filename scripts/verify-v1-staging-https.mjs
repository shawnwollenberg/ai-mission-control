import { createHash, X509Certificate } from "node:crypto";
import { resolve4, resolve6 } from "node:dns/promises";
import https from "node:https";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { assertV1StagingBootstrapManifestDigest } from "../application/v1-staging-bootstrap-manifest.ts";

const options = parseArgs({
  options: {
    url: { type: "string" },
    certificate: { type: "string" },
    "certificate-receipt": { type: "string" },
    manifest: { type: "string" },
    "manifest-digest": { type: "string" },
    "expected-build-commit": { type: "string" },
    output: { type: "string" },
  },
  strict: true,
}).values;
for (const name of [
  "url",
  "certificate",
  "certificate-receipt",
  "manifest",
  "manifest-digest",
  "expected-build-commit",
  "output",
])
  if (!options[name]) throw new Error(`--${name} is required.`);
const manifest = JSON.parse(await readFile(options.manifest, "utf8"));
assertV1StagingBootstrapManifestDigest(manifest, options["manifest-digest"]);
const certificateReceiptBytes = await readFile(options["certificate-receipt"]);
const certificateReceipt = JSON.parse(certificateReceiptBytes.toString("utf8"));
const endpoint = new URL(options.url);
if (
  endpoint.protocol !== "https:" ||
  endpoint.port ||
  endpoint.hostname !== manifest.resources.loadBalancer.dnsName ||
  certificateReceipt.runId !== manifest.runId ||
  certificateReceipt.region !== manifest.region ||
  certificateReceipt.certificateArn !== manifest.resources.certificate.arn ||
  certificateReceipt.domainName !== manifest.resources.certificate.domainName ||
  !/^[a-f0-9]{40}$/.test(options["expected-build-commit"])
)
  throw new Error("HTTPS acceptance requires the exact manifest-bound staging ALB, certificate, and source.");
const ca = await readFile(options.certificate);
const expectedCertificate = new X509Certificate(ca);
const expectedDerSha256 = createHash("sha256").update(expectedCertificate.raw).digest("hex");
const certificateFileSha256 = createHash("sha256").update(ca).digest("hex");
if (
  certificateReceipt.certificateDerSha256 !== expectedDerSha256 ||
  certificateReceipt.certificateSha256 !== certificateFileSha256
)
  throw new Error("Certificate file does not match the exact bootstrap-bound certificate receipt.");
const request = (path, method = "GET", body) =>
  new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: endpoint.hostname,
        port: 443,
        path,
        method,
        ca,
        rejectUnauthorized: true,
        servername: endpoint.hostname,
        headers: body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : undefined,
      },
      (response) => {
        const socket = response.socket;
        const peer = socket.getPeerCertificate(true);
        const tlsVersion = socket.getProtocol();
        const cipher = socket.getCipher()?.name;
        const authorized = socket.authorized;
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            path,
            method,
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            tlsVersion,
            cipher,
            certificateSubject: peer.subject,
            certificateIssuer: peer.issuer,
            certificateValidFrom: peer.valid_from,
            certificateValidTo: peer.valid_to,
            certificateDerSha256: createHash("sha256").update(peer.raw).digest("hex"),
            authorized,
          });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
let ipv6 = [];
try {
  ipv6 = await resolve6(endpoint.hostname);
} catch (error) {
  if (error?.code !== "ENODATA" && error?.code !== "ENOTFOUND") throw error;
}
const ipv4 = await resolve4(endpoint.hostname);
if (!ipv4.length) throw new Error("Staging ALB DNS has no public IPv4 result.");
const health = await request("/api/health");
const readiness = await request("/api/readiness");
const operator = await request("/api/mission-agent/replacement-bootstrap/status", "POST", JSON.stringify({}));
for (const result of [health, readiness]) {
  if (
    result.status !== 200 ||
    result.authorized !== true ||
    !["TLSv1.2", "TLSv1.3"].includes(result.tlsVersion) ||
    result.certificateDerSha256 !== expectedDerSha256
  )
    throw new Error(`Staging TLS acceptance failed for ${result.path}.`);
}
const healthBody = JSON.parse(health.body);
const readinessBody = JSON.parse(readiness.body);
const serializedIdentity = JSON.stringify([healthBody, readinessBody, health.headers, readiness.headers]);
if (!serializedIdentity.includes(options["expected-build-commit"]))
  throw new Error("HTTPS health/readiness did not expose the expected embedded server build identity.");
let operatorBody;
try {
  operatorBody = JSON.parse(operator.body);
} catch {
  throw new Error("Exact operator-protocol HTTPS client returned a non-JSON rejection.");
}
if (
  operator.status !== 403 ||
  operatorBody?.error !== "replacement_status_rejected" ||
  operator.certificateDerSha256 !== expectedDerSha256
)
  throw new Error("Exact enabled operator route did not reject the unauthenticated request with the expected 403.");
const evidence = {
  schemaVersion: "mission-control-v1-staging-https-acceptance/1",
  runId: manifest.runId,
  bootstrapManifestDigest: options["manifest-digest"],
  endpoint: endpoint.origin,
  loadBalancerArn: manifest.resources.loadBalancer.arn,
  certificateArn: certificateReceipt.certificateArn,
  certificateReceiptSha256: createHash("sha256").update(certificateReceiptBytes).digest("hex"),
  dns: { ipv4, ipv6 },
  certificateDerSha256: expectedDerSha256,
  health: { ...health, body: healthBody },
  readiness: { ...readiness, body: readinessBody },
  operatorProtocolFailClosed: { ...operator, body: operatorBody },
};
await writeFile(options.output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: "wx" });
process.stdout.write(
  `${JSON.stringify({ output: options.output, endpoint: endpoint.origin, tlsVersion: health.tlsVersion, certificateDerSha256: expectedDerSha256 })}\n`,
);
