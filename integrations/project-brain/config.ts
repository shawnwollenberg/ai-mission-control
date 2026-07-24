import path from "node:path";

export type ProjectBrainConfiguration =
  | { enabled: false; status: "not_configured" | "invalid_configuration" }
  | {
      enabled: true;
      status: "configured";
      executable: string;
      requiredVersion: string;
      contractVersion: string;
      timeoutMs: number;
      maxOutputBytes: number;
    };

function positiveInteger(name: string, value: string | undefined, fallback: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function getProjectBrainConfiguration(env: NodeJS.ProcessEnv = process.env): ProjectBrainConfiguration {
  const executable = env.PROJECT_BRAIN_EXECUTABLE?.trim();
  if (!executable) return { enabled: false, status: "not_configured" };
  if (!path.isAbsolute(executable)) throw new Error("PROJECT_BRAIN_EXECUTABLE must be an absolute path");
  return {
    enabled: true,
    status: "configured",
    executable,
    requiredVersion: env.PROJECT_BRAIN_REQUIRED_VERSION?.trim() || "0.4.0",
    contractVersion: env.PROJECT_BRAIN_CONTRACT_VERSION?.trim() || "1.0",
    timeoutMs: positiveInteger("PROJECT_BRAIN_TIMEOUT_MS", env.PROJECT_BRAIN_TIMEOUT_MS, 15_000),
    maxOutputBytes: positiveInteger("PROJECT_BRAIN_MAX_OUTPUT_BYTES", env.PROJECT_BRAIN_MAX_OUTPUT_BYTES, 1_000_000),
  };
}

export function publicProjectBrainError(error: unknown) {
  const classification =
    error && typeof error === "object" && "classification" in error
      ? String((error as { classification: unknown }).classification)
      : undefined;
  if (!classification) return "Project Brain is temporarily unavailable.";
  return (
    {
      not_installed: "Project Brain is not installed at the configured executable path.",
      timeout: "Project Brain did not finish before the configured timeout.",
      output_limit: "Project Brain returned more diagnostic data than Mission Control permits.",
      invalid_response: "Project Brain returned an invalid or mismatched structured response.",
      incompatible_contract: "The installed Project Brain version or consumer contract is incompatible.",
      operation_failed: "Project Brain could not complete this repository operation. Review operator diagnostics.",
    }[classification] ?? "Project Brain is temporarily unavailable."
  );
}
