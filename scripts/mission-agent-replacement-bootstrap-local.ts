import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { createMacOSLocalFixedOperations } from "../application/replacement-bootstrap-macos-local";
import { inspectLocalReplacementPackage } from "../application/replacement-bootstrap-local-operator";
import { readLocalJournal } from "../application/replacement-bootstrap-local-journal";
import {
  REPLACEMENT_CREDENTIAL_SERVICE,
  verifyReplacementAuthorizationPackage,
  type ReplacementAuthorizationPackage,
} from "../integrations/mission-agent/replacement-authorization-package";
import { canonicalJson } from "../integrations/mission-agent/release-authority";
import { deriveSigningKey } from "../remote-agent/protocol";
import { assertDisposableLocalOperatorEnvironment } from "../application/replacement-bootstrap-safety-gate";

const exec = promisify(execFile);
const SECURITY = "/usr/bin/security";
const CONFIG = "/Users/shawnwollenberg/.mission-agent/config.json";

async function credentialKey(credentialId: string): Promise<string> {
  if (!/^[a-f0-9-]{36}$/.test(credentialId)) throw new Error("Replacement credential ID is malformed.");
  const { stdout } = await exec(
    SECURITY,
    ["find-generic-password", "-s", REPLACEMENT_CREDENTIAL_SERVICE, "-a", credentialId, "-w"],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 8 * 1024 },
  );
  const secret = stdout.trim();
  if (secret.length < 32) throw new Error("Narrow replacement-bootstrap credential is unavailable.");
  return deriveSigningKey(secret);
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    options: {
      "authorization-package": { type: "string" },
      "evidence-output": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "inspect-journal": { type: "boolean", default: false },
    },
    strict: true,
  });
  const packagePath = parsed.values["authorization-package"];
  if (!packagePath) throw new Error("--authorization-package is required.");
  const raw = JSON.parse(await readFile(resolve(packagePath), "utf8")) as ReplacementAuthorizationPackage;
  const signingKey = await credentialKey(raw.credentialId);
  const pkg = verifyReplacementAuthorizationPackage({ value: raw, credentialSigningKey: signingKey });
  const governedEvidenceDirectory = resolve(pkg.evidenceInstructions.localDirectory);
  const evidenceDirectory = resolve(parsed.values["evidence-output"] ?? governedEvidenceDirectory);
  if (evidenceDirectory !== governedEvidenceDirectory)
    throw new Error("Evidence output must exactly match the governed authorization package directory.");
  const journalPath = join(evidenceDirectory, "replacement-host-journal.json");
  const operations = createMacOSLocalFixedOperations(resolve("."));

  if (parsed.values["inspect-journal"]) {
    const journal = await readLocalJournal(journalPath, pkg, signingKey);
    process.stdout.write(
      `${canonicalJson({
        authorizationId: pkg.authorization.authorizationId,
        phase: journal?.phase ?? "not-started",
        lastCompletedOperation: journal?.lastCompletedOperation ?? null,
        nextPermittedOperation: journal?.nextPermittedOperation ?? "inspect_host",
        receiptSequence: journal?.receiptSequence ?? 0,
      })}\n`,
    );
    return;
  }
  if (parsed.values["dry-run"]) {
    process.stdout.write(
      `${canonicalJson(
        await inspectLocalReplacementPackage({
          packagePath: resolve(packagePath),
          credentialSigningKey: signingKey,
          operations,
        }),
      )}\n`,
    );
    return;
  }
  const config = JSON.parse(await readFile(CONFIG, "utf8")) as { missionControlUrl?: string };
  if (!config.missionControlUrl)
    throw new Error("Mission Control URL is absent from the existing agent configuration.");
  assertDisposableLocalOperatorEnvironment({
    environment: process.env,
    missionControlUrl: config.missionControlUrl,
    packageInstanceIdentity: pkg.missionControlInstanceIdentity,
  });
  throw new Error(
    "Disposable execution refuses the production-bound macOS filesystem and launchd provider; use the isolated stateful acceptance provider.",
  );
}

void main();
