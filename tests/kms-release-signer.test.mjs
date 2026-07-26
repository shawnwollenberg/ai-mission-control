import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  humanSigningConfirmation,
  parseKmsKeyArn,
  pendingKmsReleaseKeyRecord,
  signReleaseWithKms,
} from "../integrations/mission-agent/kms-release-signer.ts";
import {
  canonicalJson,
  parseCanonicalSignedReleaseManifestJson,
  validatePendingReleaseKey,
} from "../integrations/mission-agent/release-authority.ts";

const keyArn = "arn:aws:kms:us-east-1:123456789012:key/11111111-1111-1111-1111-111111111111";
const releaseAuthorityKeyId = "mission-agent-release-2026-01";
const artifactPath = new URL("../public/mission-agent-0.7.0.mjs", import.meta.url);
const manifestPath = new URL("../release/mission-agent-0.7.0/unsigned-manifest-v2.json", import.meta.url);
const expectedArtifactSha256 = "3626d62a3bba757c6a8d153c651ca13d332d6fe4478897f34344a41e6473a70e";
const expectedSourceCommit = "a6d867f217c6e28ce811fbb5b8bf8778fad193c4";
const expectedReleaseVersion = "0.7.0";

function mockAws(overrides = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
  const calls = [];
  const kms = {
    async send(command) {
      calls.push(command);
      switch (command.constructor.name) {
        case "DescribeKeyCommand":
          return {
            KeyMetadata: {
              Arn: keyArn,
              KeyId: keyArn.split("/")[1],
              KeySpec: overrides.keySpec ?? "ECC_NIST_EDWARDS25519",
              KeyUsage: overrides.keyUsage ?? "SIGN_VERIFY",
              Enabled: overrides.enabled ?? true,
              KeyState: overrides.keyState ?? "Enabled",
              Origin: overrides.origin ?? "AWS_KMS",
              KeyManager: overrides.keyManager ?? "CUSTOMER",
              MultiRegion: overrides.multiRegion ?? false,
            },
          };
        case "GetPublicKeyCommand":
          return {
            KeySpec: overrides.publicKeySpec ?? "ECC_NIST_EDWARDS25519",
            KeyUsage: overrides.publicKeyUsage ?? "SIGN_VERIFY",
            SigningAlgorithms: overrides.algorithms ?? ["ED25519_SHA_512"],
            PublicKey: publicKeyDer,
          };
        case "SignCommand":
          assert.equal(command.input.KeyId, keyArn);
          assert.equal(command.input.MessageType, "RAW");
          assert.equal(command.input.SigningAlgorithm, "ED25519_SHA_512");
          return {
            Signature: sign(null, command.input.Message, privateKey),
            $metadata: { requestId: "00000000-0000-0000-0000-000000000001" },
          };
        case "VerifyCommand":
          return {
            SignatureValid: verify(null, command.input.Message, publicKey, command.input.Signature),
          };
        default:
          throw new Error(`Unexpected KMS command: ${command.constructor.name}`);
      }
    },
  };
  return {
    kms,
    sts: {
      async send() {
        return { Arn: "arn:aws:sts::123456789012:assumed-role/release-signer/shawn" };
      },
    },
    publicKeyDer,
    calls,
  };
}

async function signingInput(temp, pendingKeyRecord, overrides = {}) {
  return {
    manifestPath: manifestPath.pathname,
    artifactPath: artifactPath.pathname,
    outputBundlePath: join(temp, "signed.json"),
    outputSignaturePath: join(temp, "signature.txt"),
    outputReceiptPath: join(temp, "receipt.json"),
    expectedArtifactSha256,
    expectedSourceCommit,
    expectedReleaseVersion,
    releaseAuthorityKeyId,
    kmsKeyArn: keyArn,
    pendingKeyRecord,
    trustActivationEvidence: {
      evidenceVersion: "1",
      status: "active",
      releaseAuthorityKeyId,
      publicKeyFingerprint: pendingKeyRecord.publicKeyFingerprint,
      kmsKeyArn: keyArn,
      missionControlReleaseSha: "c".repeat(40),
      activatedAt: "2026-07-26T15:30:00.000Z",
      approvalReference: "approval:activate-release-key-2026-01",
    },
    expectedSignerRoleArn: "arn:aws:iam::123456789012:role/release-signer",
    approvalReference: "approval:test-release-070",
    humanConfirmation: humanSigningConfirmation({
      releaseVersion: expectedReleaseVersion,
      artifactSha256: expectedArtifactSha256,
      releaseAuthorityKeyId,
    }),
    signingTime: new Date("2026-07-26T16:00:00.000Z"),
    ...overrides,
  };
}

test("AWS KMS Ed25519 RAW conformance yields DER SPKI fingerprint, raw signature, and complete receipt", async () => {
  const temp = await mkdtemp(join(tmpdir(), "kms-release-test-"));
  try {
    const aws = mockAws();
    const pending = validatePendingReleaseKey(
      pendingKmsReleaseKeyRecord({
        releaseAuthorityKeyId,
        kmsKeyArn: keyArn,
        publicKeySpkiDer: aws.publicKeyDer,
        createdAt: "2026-07-26T15:00:00.000Z",
      }),
    );
    const receipt = await signReleaseWithKms(await signingInput(temp, pending), aws);
    assert.match(pending.publicKeyFingerprint, /^ed25519-spki-sha256:[a-f0-9]{64}$/);
    assert.equal(Buffer.from(await readFile(join(temp, "signature.txt"), "utf8"), "base64").length, 64);
    const bundle = parseCanonicalSignedReleaseManifestJson(await readFile(join(temp, "signed.json"), "utf8"));
    assert.equal(bundle.signature, (await readFile(join(temp, "signature.txt"), "utf8")).trim());
    assert.deepEqual(receipt.independentVerification, { localEd25519: true, awsKms: true });
    assert.equal(receipt.awsRequestId, "00000000-0000-0000-0000-000000000001");
    assert.equal(receipt.signerPrincipalArn, "arn:aws:sts::123456789012:assumed-role/release-signer/shawn");
    assert.equal(receipt.artifactSha256, expectedArtifactSha256);
    assert.equal(receipt.sourceSha, expectedSourceCommit);
    assert.equal(
      receipt.signatureSha256,
      createHash("sha256").update(Buffer.from(bundle.signature, "base64")).digest("hex"),
    );
    const serializedReceipt = await readFile(join(temp, "receipt.json"), "utf8");
    assert.doesNotMatch(serializedReceipt, /access.?key|session.?token|secret.?access|credential/i);
    assert.deepEqual(
      aws.calls.map((command) => command.constructor.name),
      ["DescribeKeyCommand", "GetPublicKeyCommand", "SignCommand", "VerifyCommand"],
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("signer fails before KMS Sign for modified artifact, identity confirmations, and human confirmation", async () => {
  for (const [field, value, pattern] of [
    ["expectedArtifactSha256", "a".repeat(64), /artifact-checksum/],
    ["expectedSourceCommit", "b".repeat(40), /Source-commit/],
    ["expectedReleaseVersion", "9.9.9", /Release-version/],
    ["releaseAuthorityKeyId", "mission-agent-release-2026-99", /key-ID/],
    ["humanConfirmation", "SIGN SOMETHING ELSE", /human confirmation/],
  ]) {
    const temp = await mkdtemp(join(tmpdir(), "kms-release-fail-"));
    try {
      const aws = mockAws();
      const pending = pendingKmsReleaseKeyRecord({
        releaseAuthorityKeyId,
        kmsKeyArn: keyArn,
        publicKeySpkiDer: aws.publicKeyDer,
        createdAt: "2026-07-26T15:00:00.000Z",
      });
      await assert.rejects(signReleaseWithKms(await signingInput(temp, pending, { [field]: value }), aws), pattern);
      assert.equal(
        aws.calls.some((command) => command.constructor.name === "SignCommand"),
        false,
      );
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
});

test("modified artifact bytes fail closed before signing", async () => {
  const temp = await mkdtemp(join(tmpdir(), "kms-release-artifact-"));
  try {
    const aws = mockAws();
    const pending = pendingKmsReleaseKeyRecord({
      releaseAuthorityKeyId,
      kmsKeyArn: keyArn,
      publicKeySpkiDer: aws.publicKeyDer,
      createdAt: "2026-07-26T15:00:00.000Z",
    });
    const modifiedArtifact = join(temp, "mission-agent-0.7.0.mjs");
    await writeFile(modifiedArtifact, "modified artifact");
    await assert.rejects(
      signReleaseWithKms(await signingInput(temp, pending, { artifactPath: modifiedArtifact }), aws),
      /Artifact bytes/,
    );
    assert.equal(aws.calls.length, 0);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("wrong KMS key shape, usage, algorithm, public key, and disabled state fail closed", async () => {
  for (const [overrides, pattern] of [
    [{ keySpec: "ECC_NIST_P256" }, /key spec/],
    [{ keyUsage: "ENCRYPT_DECRYPT" }, /key usage/],
    [{ algorithms: ["ECDSA_SHA_256"] }, /ED25519_SHA_512/],
    [{ enabled: false }, /not enabled/],
    [{ origin: "EXTERNAL" }, /generated by AWS KMS/],
    [{ keyManager: "AWS" }, /customer managed/],
    [{ multiRegion: true }, /single-region/],
  ]) {
    const temp = await mkdtemp(join(tmpdir(), "kms-release-shape-"));
    try {
      const approvedAws = mockAws();
      const pending = pendingKmsReleaseKeyRecord({
        releaseAuthorityKeyId,
        kmsKeyArn: keyArn,
        publicKeySpkiDer: approvedAws.publicKeyDer,
        createdAt: "2026-07-26T15:00:00.000Z",
      });
      const actualAws = mockAws(overrides);
      await assert.rejects(signReleaseWithKms(await signingInput(temp, pending), actualAws), pattern);
      assert.equal(
        actualAws.calls.some((command) => command.constructor.name === "SignCommand"),
        false,
      );
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
});

test("unauthorized AWS principal and incomplete activation evidence fail before KMS Sign", async () => {
  const temp = await mkdtemp(join(tmpdir(), "kms-release-authority-"));
  try {
    const aws = mockAws();
    const pending = pendingKmsReleaseKeyRecord({
      releaseAuthorityKeyId,
      kmsKeyArn: keyArn,
      publicKeySpkiDer: aws.publicKeyDer,
      createdAt: "2026-07-26T15:00:00.000Z",
    });
    const wrongPrincipalAws = {
      ...aws,
      sts: {
        async send() {
          return { Arn: "arn:aws:sts::123456789012:assumed-role/developer/shawn" };
        },
      },
    };
    await assert.rejects(
      signReleaseWithKms(await signingInput(temp, pending), wrongPrincipalAws),
      /approved human release-signer role/,
    );
    assert.equal(
      aws.calls.some((command) => command.constructor.name === "SignCommand"),
      false,
    );

    const invalidEvidence = await signingInput(temp, pending);
    invalidEvidence.trustActivationEvidence = { ...invalidEvidence.trustActivationEvidence, status: "pending" };
    await assert.rejects(signReleaseWithKms(invalidEvidence, aws), /Trust-activation evidence/);
    assert.equal(
      aws.calls.some((command) => command.constructor.name === "SignCommand"),
      false,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("wrong public key and KMS verification failure do not produce outputs", async () => {
  const temp = await mkdtemp(join(tmpdir(), "kms-release-key-"));
  try {
    const approvedAws = mockAws();
    const pending = pendingKmsReleaseKeyRecord({
      releaseAuthorityKeyId,
      kmsKeyArn: keyArn,
      publicKeySpkiDer: approvedAws.publicKeyDer,
      createdAt: "2026-07-26T15:00:00.000Z",
    });
    await assert.rejects(signReleaseWithKms(await signingInput(temp, pending), mockAws()), /pending trust record/);
    await assert.rejects(readFile(join(temp, "signed.json")), /ENOENT/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("KMS key ARN is exact and provider metadata is canonical", () => {
  assert.deepEqual(parseKmsKeyArn(keyArn), {
    region: "us-east-1",
    accountId: "123456789012",
    keyId: "11111111-1111-1111-1111-111111111111",
  });
  assert.throws(() => parseKmsKeyArn("alias/mission-agent-release"), /concrete/);
  assert.throws(() => parseKmsKeyArn("arn:aws:kms:us-east-1:123:key/not-a-key"), /concrete/);
  const aws = mockAws();
  const pending = pendingKmsReleaseKeyRecord({
    releaseAuthorityKeyId,
    kmsKeyArn: keyArn,
    publicKeySpkiDer: aws.publicKeyDer,
    createdAt: "2026-07-26T15:00:00.000Z",
  });
  assert.equal(canonicalJson(pending.kms).includes("credential"), false);
});

test("review policy makes the exact human role the sole signing principal", async () => {
  const policy = JSON.parse(await readFile(new URL("../release/aws-kms/kms-key-policy.json", import.meta.url), "utf8"));
  const allowsSign = policy.Statement.filter(
    (statement) =>
      statement.Effect === "Allow" &&
      (statement.Action === "kms:Sign" || (Array.isArray(statement.Action) && statement.Action.includes("kms:Sign"))),
  );
  assert.equal(allowsSign.length, 1);
  assert.equal(allowsSign[0].Principal.AWS, "__RELEASE_SIGNER_ROLE_ARN__");
  const denyOthers = policy.Statement.find(
    (statement) =>
      statement.Effect === "Deny" &&
      statement.Principal === "*" &&
      statement.Action === "kms:Sign" &&
      statement.Condition?.ArnNotEquals?.["aws:PrincipalArn"] === "__RELEASE_SIGNER_ROLE_ARN__",
  );
  assert.ok(denyOthers);
  for (const statement of policy.Statement.filter((candidate) => candidate.Effect === "Allow"))
    if (statement.Principal?.AWS !== "__RELEASE_SIGNER_ROLE_ARN__")
      assert.equal(Array.isArray(statement.Action) && statement.Action.includes("kms:Sign"), false);

  const trustPolicy = JSON.parse(
    await readFile(new URL("../release/aws-kms/release-signer-trust-policy.json", import.meta.url), "utf8"),
  );
  assert.equal(trustPolicy.Statement[0].Principal.AWS, "__EXACT_IDENTITY_CENTER_RELEASE_SIGNER_ROLE_ARN__");
  assert.equal(JSON.stringify(trustPolicy).includes("ArnLike"), false);
  assert.equal(JSON.stringify(trustPolicy).includes("*"), false);
});
