export const failurePolicies = {
  invalid_configuration: "non-retryable",
  repository_unavailable: "retryable",
  authentication_failure: "non-retryable",
  codex_start_failure: "retryable",
  execution_failure: "requires-human-review",
  command_failure: "requires-human-review",
  test_failure: "requires-human-review",
  timeout: "requires-human-review",
  cancellation: "non-retryable",
  worker_lost: "retryable",
  protocol_error: "non-retryable",
  artifact_failure: "requires-human-review",
  unknown: "requires-human-review",
} as const;
export type FailureClassification = keyof typeof failurePolicies;
export type RetryDisposition = (typeof failurePolicies)[FailureClassification];
export function failureDisposition(classification: FailureClassification) {
  return failurePolicies[classification];
}
