import type { ExecutionStatus } from "../domain/execution";

const successors: Record<ExecutionStatus, readonly ExecutionStatus[]> = {
  requested: ["accepted", "cancelled", "failed", "timed_out"],
  accepted: ["preparing", "cancelled", "failed", "timed_out"],
  preparing: ["running", "cancelled", "failed", "timed_out"],
  running: ["waiting_for_approval", "paused", "verifying", "failed", "timed_out", "cancelled"],
  waiting_for_approval: ["running", "paused", "failed", "timed_out", "cancelled"],
  paused: ["running", "cancelled", "failed", "timed_out"],
  verifying: ["succeeded", "failed", "timed_out", "cancelled"],
  succeeded: [],
  failed: [],
  timed_out: [],
  cancelled: [],
};

export const terminalExecutionStatuses = new Set<ExecutionStatus>(["succeeded", "failed", "timed_out", "cancelled"]);

export type GovernedExecutionObservation = {
  workspaceId: string;
  missionId: string;
  childMissionId?: string | null;
  executionId: string;
  assignmentId: string;
  assignmentAttempt: number;
  leaseReceiptId: string;
  leaseIdentity: string;
  fencingToken: number;
  providerAttemptId?: string | null;
  status: ExecutionStatus;
  aggregateVersion: number;
  projectionEventPosition: number;
  latestEventId: string;
  latestEventType: string;
  latestEventAggregateVersion: number;
  timeoutAt: Date;
  assignmentStatus: string;
  pendingValidationCount: number;
  validationReceiptCount: number;
  implementationArtifactCount: number;
};

export type GovernedExecutionBinding = Pick<
  GovernedExecutionObservation,
  | "workspaceId"
  | "missionId"
  | "childMissionId"
  | "executionId"
  | "assignmentId"
  | "assignmentAttempt"
  | "leaseReceiptId"
  | "leaseIdentity"
  | "fencingToken"
>;

function providerGeneration(value: string | null | undefined, assignmentAttempt: number) {
  if (value == null) return null;
  const match = /^(\d+)-(\d+)$/.exec(value);
  if (!match || Number(match[1]) !== assignmentAttempt || Number(match[2]) < 1)
    throw new Error("Governed execution providerAttemptId is not bound to the assignment attempt");
  return Number(match[2]);
}

function reachable(from: ExecutionStatus, target: ExecutionStatus) {
  if (from === target) return true;
  const pending = [...successors[from]];
  const seen = new Set<ExecutionStatus>([from]);
  while (pending.length) {
    const state = pending.shift()!;
    if (state === target) return true;
    if (seen.has(state)) continue;
    seen.add(state);
    pending.push(...successors[state]);
  }
  return false;
}

export function assertExecutionTerminalEvidenceBarrier(
  observation: GovernedExecutionObservation,
  expectedTerminal: ExecutionStatus,
) {
  if (!terminalExecutionStatuses.has(observation.status) || observation.status !== expectedTerminal)
    throw new Error("Final execution evidence cannot be consumed before the required terminal barrier");
  if (expectedTerminal === "succeeded" && observation.validationReceiptCount < 1)
    throw new Error("Successful execution terminal barrier lacks an authoritative validation receipt");
  if (expectedTerminal === "succeeded" && observation.implementationArtifactCount < 1)
    throw new Error("Successful execution terminal barrier lacks an authoritative implementation artifact");
}

export function assertGovernedExecutionObservation(
  binding: GovernedExecutionBinding,
  previous: GovernedExecutionObservation,
  current: GovernedExecutionObservation,
) {
  for (const key of [
    "workspaceId",
    "missionId",
    "childMissionId",
    "executionId",
    "assignmentId",
    "assignmentAttempt",
    "leaseReceiptId",
    "leaseIdentity",
    "fencingToken",
  ] as const)
    if (current[key] !== binding[key]) throw new Error(`Governed execution ${key} changed during observation`);
  const previousProviderGeneration = providerGeneration(previous.providerAttemptId, binding.assignmentAttempt);
  const currentProviderGeneration = providerGeneration(current.providerAttemptId, binding.assignmentAttempt);
  if (previousProviderGeneration != null && currentProviderGeneration == null)
    throw new Error("Governed execution providerAttemptId disappeared during observation");
  if (
    previousProviderGeneration != null &&
    currentProviderGeneration != null &&
    currentProviderGeneration < previousProviderGeneration
  )
    throw new Error("Governed execution providerAttemptId generation regressed");
  if (current.aggregateVersion < previous.aggregateVersion)
    throw new Error("Governed execution aggregate version regressed");
  if (current.projectionEventPosition < previous.projectionEventPosition)
    throw new Error("Governed execution projection event position regressed");
  if (current.aggregateVersion === previous.aggregateVersion && current.status !== previous.status)
    throw new Error("Governed execution projection/event identity mismatch");
  if (current.aggregateVersion !== current.latestEventAggregateVersion)
    throw new Error("Governed execution projection/event aggregate version mismatch");
  if (!reachable(previous.status, current.status))
    throw new Error(`Illegal governed execution transition observed: ${previous.status}->${current.status}`);
}

export async function observeGovernedExecutionTerminal(input: {
  initial: GovernedExecutionObservation;
  read: () => Promise<GovernedExecutionObservation>;
  expectedTerminal: ExecutionStatus;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  pollMilliseconds?: number;
}) {
  if (!terminalExecutionStatuses.has(input.expectedTerminal))
    throw new Error(`Expected execution state is not terminal: ${input.expectedTerminal}`);
  const binding: GovernedExecutionBinding = { ...input.initial };
  const now = input.now ?? Date.now;
  const wait = input.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const startedAt = now();
  const deadline = input.initial.timeoutAt.getTime();
  let current = input.initial;
  for (;;) {
    if (terminalExecutionStatuses.has(current.status)) {
      if (current.status !== input.expectedTerminal)
        throw new Error(`Governed execution reached ${current.status}; expected ${input.expectedTerminal}`);
      return { observation: current, elapsedMilliseconds: now() - startedAt };
    }
    if (now() >= deadline)
      throw new Error(
        `Governed execution observation timed out: ${JSON.stringify({ executionId: current.executionId, lastState: current.status, lastAggregateVersion: current.aggregateVersion, lastProjectionEventPosition: current.projectionEventPosition, lastEventId: current.latestEventId, lastEventType: current.latestEventType, elapsedMilliseconds: now() - startedAt, expectedTerminal: input.expectedTerminal })}`,
      );
    await wait(Math.min(input.pollMilliseconds ?? 100, Math.max(0, deadline - now())));
    const next = await input.read();
    assertGovernedExecutionObservation(binding, current, next);
    current = next;
  }
}

export function assertWorkspaceExecutionQuiescence(
  rows: Array<{
    executionId: string;
    executionStatus: ExecutionStatus;
    assignmentStatus: string;
    liveProviderCount: number;
    pendingValidationCount: number;
  }>,
) {
  const active = rows.filter(
    (row) =>
      !terminalExecutionStatuses.has(row.executionStatus) ||
      ["available", "claimed", "acknowledged"].includes(row.assignmentStatus) ||
      row.liveProviderCount !== 0 ||
      row.pendingValidationCount !== 0,
  );
  if (active.length) throw new Error(`Workspace is not quiescent for replay: ${JSON.stringify(active)}`);
}
