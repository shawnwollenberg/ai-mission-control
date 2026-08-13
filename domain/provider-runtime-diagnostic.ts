import { ValidationFailedError } from "@/lib/application-errors";
import { assertConsensusArtifactSecretSafe } from "@/domain/consensus-plan";
import { canonicalHash } from "@/lib/canonical-json";

export const providerRuntimeDiagnosticSchemaVersion = "provider-runtime-diagnostic/1" as const;
// Consensus permits at most ten retries after the initial invocation.
export const maximumProviderRuntimeDiagnosticHistory = 11;

export type ProviderRuntimeDiagnostic = {
  schemaVersion: typeof providerRuntimeDiagnosticSchemaVersion;
  provider: "codex" | "claude_code";
  requestedModel: string;
  cliVersion: string;
  runtimeProfileId: string;
  runtimeProfileHash: string;
  sandboxProfileHash: string;
  providerAttemptId: string;
  retryOrdinal: number;
  retryLimit: number;
  failureCategory: string;
  failureStatus: string;
  retryDecision: "not_required" | "retry_authorized" | "retry_limit_exhausted" | "terminal_failure";
  retryCommandId: string;
  replacementProviderAttemptId: string | null;
  processStartedAt: string;
  processTerminatedAt: string;
  exitCode: number | null;
  terminationSignal: string | null;
  timedOut: boolean;
  cancellationRequested: boolean;
  stdoutHash: string;
  stderrHash: string;
  stdoutExcerpt: string | null;
  stderrExcerpt: string | null;
  textAvailable: boolean;
  failedInitializationPhase: string;
  childProcess: {
    pid: number;
    processGroupId: number;
    detachedProcessGroup: boolean;
    processTreeTerminationAttempted: boolean;
    processTreeTerminationVerified: boolean;
  };
  sandboxDenial: { detected: boolean; excerpt: string | null };
  temporaryDirectoryIdentity: string;
  workingDirectoryIdentity: string;
  environmentVariableNames: string[];
  localSecretScan: "passed_exact_and_pattern" | "text_unavailable";
};

const checksum = /^[a-f0-9]{64}$/;
const token = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const signal = /^[A-Z0-9]{1,16}$/;

function text(value: unknown, name: string, maximum: number) {
  if (typeof value !== "string" || !value || value.length > maximum)
    throw new ValidationFailedError(`Invalid provider diagnostic ${name}`);
  return value;
}

function optionalExcerpt(value: unknown, name: string) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 1000)
    throw new ValidationFailedError(`Invalid provider diagnostic ${name}`);
  return value;
}

export function parseProviderRuntimeDiagnostic(value: unknown): ProviderRuntimeDiagnostic {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ValidationFailedError("Provider diagnostic must be an object");
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion",
    "provider",
    "requestedModel",
    "cliVersion",
    "runtimeProfileId",
    "runtimeProfileHash",
    "sandboxProfileHash",
    "providerAttemptId",
    "retryOrdinal",
    "retryLimit",
    "failureCategory",
    "failureStatus",
    "retryDecision",
    "retryCommandId",
    "replacementProviderAttemptId",
    "processStartedAt",
    "processTerminatedAt",
    "exitCode",
    "terminationSignal",
    "timedOut",
    "cancellationRequested",
    "stdoutHash",
    "stderrHash",
    "stdoutExcerpt",
    "stderrExcerpt",
    "textAvailable",
    "failedInitializationPhase",
    "childProcess",
    "sandboxDenial",
    "temporaryDirectoryIdentity",
    "workingDirectoryIdentity",
    "environmentVariableNames",
    "localSecretScan",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key)))
    throw new ValidationFailedError("Provider diagnostic contains unsupported fields");
  if (input.schemaVersion !== providerRuntimeDiagnosticSchemaVersion)
    throw new ValidationFailedError("Unsupported provider diagnostic schema");
  if (!(["codex", "claude_code"] as unknown[]).includes(input.provider))
    throw new ValidationFailedError("Invalid provider diagnostic provider");
  const requestedModel = text(input.requestedModel, "requestedModel", 128);
  const cliVersion = text(input.cliVersion, "cliVersion", 160);
  const runtimeProfileId = text(input.runtimeProfileId, "runtimeProfileId", 160);
  const providerAttemptId = text(input.providerAttemptId, "providerAttemptId", 160);
  const retryOrdinal = input.retryOrdinal ?? 0;
  const retryLimit = input.retryLimit ?? 0;
  const failureCategory = text(input.failureCategory ?? "legacy_unspecified", "failureCategory", 80);
  const failureStatus = text(input.failureStatus ?? "legacy:unspecified", "failureStatus", 80);
  const retryDecision = input.retryDecision ?? "not_required";
  const retryCommandId = text(input.retryCommandId ?? "00000000-0000-4000-8000-000000000000", "retryCommandId", 80);
  const replacementProviderAttemptId = input.replacementProviderAttemptId ?? null;
  if (![requestedModel, runtimeProfileId, providerAttemptId].every((item) => identifier.test(item)))
    throw new ValidationFailedError("Invalid provider diagnostic identifier");
  if (
    !Number.isSafeInteger(retryOrdinal) ||
    Number(retryOrdinal) < 0 ||
    !Number.isSafeInteger(retryLimit) ||
    Number(retryLimit) < 0 ||
    Number(retryLimit) > 10 ||
    !((retryOrdinal as number) <= (retryLimit as number)) ||
    !identifier.test(failureCategory) ||
    !identifier.test(failureStatus) ||
    !/^[0-9a-f-]{36}$/i.test(retryCommandId) ||
    !(
      replacementProviderAttemptId === null ||
      (typeof replacementProviderAttemptId === "string" && identifier.test(replacementProviderAttemptId))
    ) ||
    !(["not_required", "retry_authorized", "retry_limit_exhausted", "terminal_failure"] as unknown[]).includes(
      retryDecision,
    )
  )
    throw new ValidationFailedError("Invalid provider diagnostic retry evidence");
  for (const key of [
    "runtimeProfileHash",
    "sandboxProfileHash",
    "stdoutHash",
    "stderrHash",
    "temporaryDirectoryIdentity",
    "workingDirectoryIdentity",
  ])
    if (typeof input[key] !== "string" || !checksum.test(input[key] as string))
      throw new ValidationFailedError(`Invalid provider diagnostic ${key}`);
  const processStartedAt = text(input.processStartedAt, "processStartedAt", 40);
  const processTerminatedAt = text(input.processTerminatedAt, "processTerminatedAt", 40);
  if (
    ![processStartedAt, processTerminatedAt].every((item) => Number.isFinite(Date.parse(item))) ||
    Date.parse(processTerminatedAt) < Date.parse(processStartedAt)
  )
    throw new ValidationFailedError("Invalid provider diagnostic process time");
  if (
    input.exitCode !== null &&
    (!Number.isInteger(input.exitCode) || Number(input.exitCode) < 0 || Number(input.exitCode) > 255)
  )
    throw new ValidationFailedError("Invalid provider diagnostic exit code");
  if (
    input.terminationSignal !== null &&
    (typeof input.terminationSignal !== "string" || !signal.test(input.terminationSignal))
  )
    throw new ValidationFailedError("Invalid provider diagnostic signal");
  if (![input.timedOut, input.cancellationRequested, input.textAvailable].every((item) => typeof item === "boolean"))
    throw new ValidationFailedError("Invalid provider diagnostic state flags");
  const childProcess = input.childProcess as Record<string, unknown> | undefined;
  const sandboxDenial = input.sandboxDenial as Record<string, unknown> | undefined;
  if (
    !childProcess ||
    Object.keys(childProcess).some(
      (key) =>
        ![
          "pid",
          "processGroupId",
          "detachedProcessGroup",
          "processTreeTerminationAttempted",
          "processTreeTerminationVerified",
        ].includes(key),
    ) ||
    !Number.isSafeInteger(childProcess.pid) ||
    Number(childProcess.pid) <= 1 ||
    !Number.isSafeInteger(childProcess.processGroupId) ||
    childProcess.processGroupId !== childProcess.pid ||
    typeof childProcess.detachedProcessGroup !== "boolean" ||
    typeof childProcess.processTreeTerminationAttempted !== "boolean" ||
    typeof childProcess.processTreeTerminationVerified !== "boolean"
  )
    throw new ValidationFailedError("Invalid provider diagnostic child process evidence");
  if (
    !sandboxDenial ||
    Object.keys(sandboxDenial).some((key) => !["detected", "excerpt"].includes(key)) ||
    typeof sandboxDenial.detected !== "boolean"
  )
    throw new ValidationFailedError("Invalid provider diagnostic sandbox evidence");
  const stdoutExcerpt = optionalExcerpt(input.stdoutExcerpt, "stdoutExcerpt");
  const stderrExcerpt = optionalExcerpt(input.stderrExcerpt, "stderrExcerpt");
  const sandboxExcerpt = optionalExcerpt(sandboxDenial.excerpt, "sandboxDenial.excerpt");
  const environmentVariableNames = input.environmentVariableNames;
  if (
    !Array.isArray(environmentVariableNames) ||
    environmentVariableNames.length > 32 ||
    environmentVariableNames.some((item) => typeof item !== "string" || !token.test(item))
  )
    throw new ValidationFailedError("Invalid provider diagnostic environment names");
  if (!(["passed_exact_and_pattern", "text_unavailable"] as unknown[]).includes(input.localSecretScan))
    throw new ValidationFailedError("Invalid provider diagnostic secret scan");
  return {
    schemaVersion: providerRuntimeDiagnosticSchemaVersion,
    provider: input.provider as "codex" | "claude_code",
    requestedModel,
    cliVersion,
    runtimeProfileId,
    runtimeProfileHash: input.runtimeProfileHash as string,
    sandboxProfileHash: input.sandboxProfileHash as string,
    providerAttemptId,
    retryOrdinal: retryOrdinal as number,
    retryLimit: retryLimit as number,
    failureCategory,
    failureStatus,
    retryDecision: retryDecision as ProviderRuntimeDiagnostic["retryDecision"],
    retryCommandId,
    replacementProviderAttemptId: replacementProviderAttemptId as string | null,
    processStartedAt,
    processTerminatedAt,
    exitCode: input.exitCode as number | null,
    terminationSignal: input.terminationSignal as string | null,
    timedOut: input.timedOut as boolean,
    cancellationRequested: input.cancellationRequested as boolean,
    stdoutHash: input.stdoutHash as string,
    stderrHash: input.stderrHash as string,
    stdoutExcerpt,
    stderrExcerpt,
    textAvailable: input.textAvailable as boolean,
    failedInitializationPhase: text(input.failedInitializationPhase, "failedInitializationPhase", 80),
    childProcess: childProcess as ProviderRuntimeDiagnostic["childProcess"],
    sandboxDenial: { detected: sandboxDenial.detected as boolean, excerpt: sandboxExcerpt },
    temporaryDirectoryIdentity: input.temporaryDirectoryIdentity as string,
    workingDirectoryIdentity: input.workingDirectoryIdentity as string,
    environmentVariableNames: Array.from(new Set(environmentVariableNames as string[])).sort(),
    localSecretScan: input.localSecretScan as ProviderRuntimeDiagnostic["localSecretScan"],
  };
}

export function serverSanitizeProviderRuntimeDiagnostic(value: unknown) {
  const parsed = parseProviderRuntimeDiagnostic(value);
  const excerpts = [parsed.stdoutExcerpt, parsed.stderrExcerpt, parsed.sandboxDenial.excerpt].filter(
    (item): item is string => item !== null,
  );
  let serverSecretScan: "passed" | "text_removed" = "passed";
  try {
    assertConsensusArtifactSecretSafe(Buffer.from(excerpts.join("\n")));
  } catch {
    serverSecretScan = "text_removed";
  }
  const diagnostic =
    serverSecretScan === "passed"
      ? parsed
      : {
          ...parsed,
          stdoutExcerpt: null,
          stderrExcerpt: null,
          textAvailable: false,
          sandboxDenial: { ...parsed.sandboxDenial, excerpt: null },
          localSecretScan: "text_unavailable" as const,
        };
  return { diagnostic, serverSecretScan, diagnosticHash: canonicalHash({ diagnostic, serverSecretScan }) };
}
