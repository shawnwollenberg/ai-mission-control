import { createHash, createPublicKey, verify } from "node:crypto";
import { canonicalJson } from "@/application/v1-production-runtime-identity";

const SHA256 = /^[a-f0-9]{64}$/;
const RDS_ARN = /^arn:aws:rds:([a-z0-9-]+):(\d{12}):db:([a-z0-9-]+)$/;

export type V1StagingDatabaseAuthority = {
  hostname: string;
  port: number;
  databaseName: string;
  username: string;
  tlsMode: "verify-full";
};

export type V1StagingDatabaseBindingReceipt = {
  schemaVersion: "mission-control-v1-staging-database-binding/1";
  runId: string;
  bootstrapManifestDigest: string;
  observedAt: string;
  expiresAt: string;
  accountId: string;
  region: string;
  rdsArn: string;
  resourceId: string;
  endpoint: string;
  port: 5432;
  databaseName: string;
  caIdentifier: string;
  schemaCompatibility: { minimum: "0028"; maximum: "0030" };
  runtime: V1StagingDatabaseAuthority;
  controller: V1StagingDatabaseAuthority;
  attestationRequest: {
    schemaVersion: "mission-control-v1-staging-attestation-request/1";
    kind: "database-binding";
    runId: string;
    accountId: string;
    region: string;
    bootstrapManifestDigest: string;
    observedAt: string;
    expiresAt: string;
    nonce: string;
    evidence: Omit<V1StagingDatabaseBindingReceipt, "attestationRequest" | "signature">;
  };
  signature: string;
};

export function databaseAuthorityFromUrl(connectionString: string): V1StagingDatabaseAuthority {
  const url = new URL(connectionString);
  const tlsMode = url.searchParams.get("sslmode");
  if (url.protocol !== "postgresql:" || !url.username || !url.password || tlsMode !== "verify-full")
    throw new Error("Staging database URL must use PostgreSQL with credentials and verify-full TLS.");
  return {
    hostname: url.hostname,
    port: Number(url.port || "5432"),
    databaseName: url.pathname.replace(/^\//, ""),
    username: decodeURIComponent(url.username),
    tlsMode,
  };
}

export function databaseAuthorityDigest(authority: V1StagingDatabaseAuthority): string {
  return createHash("sha256").update(canonicalJson(authority)).digest("hex");
}

export function verifyV1StagingDatabaseBinding(
  receipt: V1StagingDatabaseBindingReceipt,
  publicKeySpkiDerBase64: string,
  runtimeUrl: string,
  controllerUrl?: string,
  expected?: { runId: string; manifestDigest: string; accountId: string; region: string },
  now = Date.now(),
): void {
  const match = RDS_ARN.exec(receipt.rdsArn);
  const unsigned = { ...receipt } as Partial<V1StagingDatabaseBindingReceipt>;
  delete unsigned.attestationRequest;
  delete unsigned.signature;
  if (
    receipt.schemaVersion !== "mission-control-v1-staging-database-binding/1" ||
    !match ||
    match[1] !== receipt.region ||
    match[2] !== receipt.accountId ||
    match[3] !== receipt.resourceId ||
    !SHA256.test(receipt.bootstrapManifestDigest) ||
    !receipt.endpoint.endsWith(`.${receipt.region}.rds.amazonaws.com`) ||
    receipt.port !== 5432 ||
    receipt.caIdentifier !== "rds-ca-rsa2048-g1" ||
    receipt.runtime.hostname !== receipt.endpoint ||
    receipt.controller.hostname !== receipt.endpoint ||
    receipt.runtime.databaseName !== receipt.databaseName ||
    receipt.controller.databaseName !== receipt.databaseName ||
    receipt.runtime.tlsMode !== "verify-full" ||
    receipt.controller.tlsMode !== "verify-full" ||
    receipt.runtime.username !== "mission_control_v1_staging_runtime" ||
    receipt.controller.username !== "mission_control_v1_staging_controller" ||
    receipt.schemaCompatibility.minimum !== "0028" ||
    receipt.schemaCompatibility.maximum !== "0030" ||
    receipt.attestationRequest?.kind !== "database-binding" ||
    receipt.attestationRequest.runId !== receipt.runId ||
    receipt.attestationRequest.accountId !== receipt.accountId ||
    receipt.attestationRequest.region !== receipt.region ||
    receipt.attestationRequest.bootstrapManifestDigest !== receipt.bootstrapManifestDigest ||
    canonicalJson(receipt.attestationRequest.evidence) !== canonicalJson(unsigned) ||
    !Number.isFinite(Date.parse(receipt.observedAt)) ||
    !Number.isFinite(Date.parse(receipt.expiresAt)) ||
    Date.parse(receipt.observedAt) > now + 60_000 ||
    Date.parse(receipt.expiresAt) <= now ||
    (expected &&
      (receipt.runId !== expected.runId ||
        receipt.bootstrapManifestDigest !== expected.manifestDigest ||
        receipt.accountId !== expected.accountId ||
        receipt.region !== expected.region))
  )
    throw new Error("Staging database control-plane binding is malformed, stale, or contradictory.");
  const publicKey = createPublicKey({
    key: Buffer.from(publicKeySpkiDerBase64, "base64"),
    format: "der",
    type: "spki",
  });
  if (
    publicKey.asymmetricKeyType !== "ed25519" ||
    !verify(
      null,
      new Uint8Array(Buffer.from(canonicalJson(receipt.attestationRequest))),
      publicKey,
      new Uint8Array(Buffer.from(receipt.signature, "base64")),
    )
  )
    throw new Error("Staging database control-plane binding signature is invalid.");
  if (canonicalJson(databaseAuthorityFromUrl(runtimeUrl)) !== canonicalJson(receipt.runtime))
    throw new Error("Runtime database secret contradicts staging RDS authority.");
  if (controllerUrl && canonicalJson(databaseAuthorityFromUrl(controllerUrl)) !== canonicalJson(receipt.controller))
    throw new Error("Controller database secret contradicts staging RDS authority.");
}
