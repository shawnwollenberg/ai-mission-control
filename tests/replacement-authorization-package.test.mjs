import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  MISSION_CONTROL_INSTANCE_ID,
  REPLACEMENT_CLAIM_PATH,
  REPLACEMENT_CREDENTIAL_PROTOCOL,
  REPLACEMENT_DECISION_PATH,
  REPLACEMENT_FAILURE_PATH,
  REPLACEMENT_INTENT_PATH,
  REPLACEMENT_PACKAGE_VERSION,
  REPLACEMENT_RECEIPT_PATH,
  REPLACEMENT_STATUS_PATH,
  createReplacementAuthorizationPackage,
  verifyReplacementAuthorizationPackage,
} from "../integrations/mission-agent/replacement-authorization-package.ts";
import {
  authorizationChecksum,
  validateReplacementAuthorization,
} from "../integrations/mission-agent/replacement-bootstrap.ts";

const authorization = validateReplacementAuthorization(
  JSON.parse(await readFile("release/mission-agent-0.7.2/replacement-bootstrap/simulation-authorization.json", "utf8")),
  { now: new Date("2026-07-28T00:00:00.000Z") },
);
const key = "a".repeat(64);
const unsigned = {
  packageVersion: REPLACEMENT_PACKAGE_VERSION,
  protocolVersion: authorization.protocolVersion,
  credentialProtocol: REPLACEMENT_CREDENTIAL_PROTOCOL,
  credentialId: "22222222-2222-4222-8222-222222222222",
  missionControlInstanceIdentity: MISSION_CONTROL_INSTANCE_ID,
  claimPath: REPLACEMENT_CLAIM_PATH,
  intentPath: REPLACEMENT_INTENT_PATH,
  receiptPath: REPLACEMENT_RECEIPT_PATH,
  decisionPath: REPLACEMENT_DECISION_PATH,
  statusPath: REPLACEMENT_STATUS_PATH,
  failurePath: REPLACEMENT_FAILURE_PATH,
  executionId: "33333333-3333-4333-8333-333333333333",
  nonce: "replacement_bootstrap_nonce_0123456789abcdef",
  issuedAt: authorization.approvedAt,
  expiresAt: authorization.expiresAt,
  maximumUseCount: 1,
  authorization,
  approval: {
    approvalId: authorization.approvalId,
    status: "granted",
    decidedBy: authorization.approvedBy,
    actionHash: authorizationChecksum(authorization),
    decidedAt: authorization.approvedAt,
    expiresAt: authorization.expiresAt,
  },
  authorizationFingerprint: authorizationChecksum(authorization),
  evidenceInstructions: {
    mode: "authenticated-receipt-api",
    localDirectory: authorization.evidenceDestination,
    receiptSequenceStartsAt: 1,
  },
};

test("replacement package authenticates every authorization and approval byte", () => {
  const pkg = createReplacementAuthorizationPackage({ unsigned, credentialSigningKey: key });
  assert.equal(
    verifyReplacementAuthorizationPackage({
      value: pkg,
      credentialSigningKey: key,
      now: new Date("2026-07-28T00:00:00.000Z"),
    }).packageChecksum,
    pkg.packageChecksum,
  );
});

test("expired package bytes remain verifiable only for governed recovery", () => {
  const pkg = createReplacementAuthorizationPackage({ unsigned, credentialSigningKey: key });
  const afterExpiry = new Date("2026-08-04T00:00:00.000Z");
  assert.throws(
    () =>
      verifyReplacementAuthorizationPackage({
        value: pkg,
        credentialSigningKey: key,
        now: afterExpiry,
      }),
    /expiry|expired/i,
  );
  assert.equal(
    verifyReplacementAuthorizationPackage({
      value: pkg,
      credentialSigningKey: key,
      now: afterExpiry,
      allowExpiredRecovery: true,
    }).packageChecksum,
    pkg.packageChecksum,
  );
});

test("package mutation and wrong credentials fail authentication", () => {
  const pkg = createReplacementAuthorizationPackage({ unsigned, credentialSigningKey: key });
  for (const changed of [
    { ...pkg, nonce: "changed_nonce_0123456789abcdef0123456789" },
    { ...pkg, executionId: "44444444-4444-4444-8444-444444444444" },
    { ...pkg, authorizationFingerprint: "0".repeat(64) },
    { ...pkg, approval: { ...pkg.approval, decidedBy: "other" } },
    { ...pkg, extra: true },
  ])
    assert.throws(
      () =>
        verifyReplacementAuthorizationPackage({
          value: changed,
          credentialSigningKey: key,
          now: new Date("2026-07-28T00:00:00.000Z"),
        }),
      /binding|checksum|authentication|unknown fields/i,
    );
  assert.throws(
    () =>
      verifyReplacementAuthorizationPackage({
        value: pkg,
        credentialSigningKey: "b".repeat(64),
        now: new Date("2026-07-28T00:00:00.000Z"),
      }),
    /authentication/i,
  );
});

test("expired, wrong-agent, substituted smoke, and unknown credential protocols fail closed", () => {
  const cases = [
    { ...unsigned, credentialProtocol: "remote-agent-1.0" },
    { ...unsigned, maximumUseCount: 2 },
    {
      ...unsigned,
      authorization: {
        ...authorization,
        smokeMission: { ...authorization.smokeMission, templateId: "arbitrary" },
      },
    },
  ];
  for (const changed of cases)
    assert.throws(
      () => createReplacementAuthorizationPackage({ unsigned: changed, credentialSigningKey: key }),
      /binding|authorization/i,
    );
  const pkg = createReplacementAuthorizationPackage({ unsigned, credentialSigningKey: key });
  assert.throws(
    () =>
      verifyReplacementAuthorizationPackage({
        value: pkg,
        credentialSigningKey: key,
        now: new Date("2026-08-04T00:00:00.000Z"),
      }),
    /expired/i,
  );
});

export { authorization, key, unsigned };
