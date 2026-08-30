import type { ProviderFailureCode } from "../runtime/bindings";
import type { WorkerActor } from "./protocol";

export type FailedDispatchRecovery = "READ_ONLY_ARCHITECT_REPLACEMENT" | "ENGINEER_THREAD_REPLACEMENT";

const readOnlyArchitectFailures = new Set<ProviderFailureCode>([
  "PROVIDER_THREAD_UNAVAILABLE",
  "PROVIDER_OUTPUT_INVALID",
  "PROVIDER_PROCESS_FAILED",
]);

export function failedDispatchRecovery(
  actor: WorkerActor,
  failureCode: string | undefined,
): FailedDispatchRecovery | undefined {
  if (!failureCode) return undefined;
  if (actor === "ARCHITECT" && readOnlyArchitectFailures.has(failureCode as ProviderFailureCode))
    return "READ_ONLY_ARCHITECT_REPLACEMENT";
  if (actor === "ENGINEER" && failureCode === "PROVIDER_THREAD_UNAVAILABLE") return "ENGINEER_THREAD_REPLACEMENT";
  return undefined;
}

export function isIndeterminateFailure(failureCode: string | undefined) {
  return failureCode === "PROVIDER_DISPATCH_INDETERMINATE";
}
