import type { ProviderFailure, ProviderFailureCode } from "./bindings";

const messages: Record<ProviderFailureCode, string> = {
  CODEX_AUTHENTICATION_EXPIRED: "Codex authentication expired",
  CODEX_USAGE_LIMIT_REACHED: "Codex usage limit reached",
  PROVIDER_THREAD_UNAVAILABLE: "Provider thread unavailable — reconciliation required",
  PROVIDER_OUTPUT_INVALID: "Provider output failed validation",
  PROVIDER_PROCESS_FAILED: "Provider process failed",
  PROVIDER_RECOVERY_EXHAUSTED: "Provider thread recovery failed — operator reconciliation required",
  PROVIDER_DISPATCH_INDETERMINATE: "Provider dispatch outcome is indeterminate — reconciliation required",
  MISSION_SOURCE_CHANGED: "GitHub Mission envelope changed after dispatch — reconciliation required",
  GITHUB_UNAVAILABLE: "GitHub unavailable — retry when service is restored",
};

export class V2OperationalError extends Error {
  constructor(
    readonly code: ProviderFailureCode,
    message = messages[code],
  ) {
    super(message);
    this.name = "V2OperationalError";
  }
}

export function classifyProviderFailure(
  error: unknown,
  actor: ProviderFailure["actor"],
  revision: number,
): ProviderFailure {
  if (error instanceof V2OperationalError)
    return { code: error.code, message: error.message, actor, revision, occurredAt: new Date().toISOString() };
  const raw = error instanceof Error ? error.message.toLowerCase() : "";
  const code: ProviderFailureCode = raw.includes("provider_recovery_exhausted")
    ? "PROVIDER_RECOVERY_EXHAUSTED"
    : raw.includes("github") || raw.includes("gh exited") || raw.includes("issues request")
      ? "GITHUB_UNAVAILABLE"
      : raw.includes("auth") || raw.includes("unauthorized") || raw.includes("sign in")
        ? "CODEX_AUTHENTICATION_EXPIRED"
        : raw.includes("usage") || raw.includes("limit") || raw.includes("quota")
          ? "CODEX_USAGE_LIMIT_REACHED"
          : raw.includes("thread") && (raw.includes("not found") || raw.includes("resume"))
            ? "PROVIDER_THREAD_UNAVAILABLE"
            : raw.includes("json") || raw.includes("schema") || raw.includes("output") || raw.includes("revision")
              ? "PROVIDER_OUTPUT_INVALID"
              : "PROVIDER_PROCESS_FAILED";
  return { code, message: messages[code], actor, revision, occurredAt: new Date().toISOString() };
}

export function operationalLog(input: {
  event: string;
  missionId: string;
  revision: number;
  actor?: string;
  idempotencyKey?: string;
  providerThreadId?: string;
  resultState?: string;
  failureCode?: string;
}) {
  console.info(JSON.stringify({ schema: "mc.operational-log/v1", occurredAt: new Date().toISOString(), ...input }));
}
