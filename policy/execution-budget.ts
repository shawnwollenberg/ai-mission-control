import { ValidationFailedError } from "@/lib/application-errors";
export type ExecutionBudget = {
  maxDurationSeconds: number;
  maxRetries: number;
  maxCommands: number;
  maxArtifactBytes: number;
  maxLogBytes: number;
  maxEstimatedModelCost?: number;
  maxTokens?: number;
};
export function enforceExecutionBudget(
  budget: ExecutionBudget,
  usage: {
    durationSeconds?: number;
    retries?: number;
    commands?: number;
    artifactBytes?: number;
    logBytes?: number;
    estimatedModelCost?: number;
    tokens?: number;
  },
) {
  const checks: [keyof typeof usage, keyof ExecutionBudget][] = [
    ["durationSeconds", "maxDurationSeconds"],
    ["retries", "maxRetries"],
    ["commands", "maxCommands"],
    ["artifactBytes", "maxArtifactBytes"],
    ["logBytes", "maxLogBytes"],
    ["estimatedModelCost", "maxEstimatedModelCost"],
    ["tokens", "maxTokens"],
  ];
  for (const [used, limit] of checks) {
    const value = usage[used],
      maximum = budget[limit];
    if (value !== undefined && maximum !== undefined && value > maximum)
      throw new ValidationFailedError(`Execution hard limit exceeded: ${String(limit)}`, {
        used: value,
        limit: maximum,
      });
  }
}
