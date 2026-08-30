export function coordinationBackoffMs(consecutiveFailures: number, intervalMs: number, maximumMs = 300_000) {
  if (!Number.isSafeInteger(consecutiveFailures) || consecutiveFailures < 1)
    throw new Error("Consecutive failures must be positive");
  return Math.min(intervalMs * 2 ** (consecutiveFailures - 1), maximumMs);
}

export async function waitForCoordinationRetry(input: {
  backoffMs: number;
  heartbeatIntervalMs: number;
  delay: (milliseconds: number) => Promise<unknown>;
  heartbeat: () => Promise<unknown>;
  shouldStop: () => boolean;
}) {
  let remainingMs = input.backoffMs;
  while (remainingMs > 0 && !input.shouldStop()) {
    const sliceMs = Math.min(input.heartbeatIntervalMs, remainingMs);
    await input.delay(sliceMs);
    remainingMs -= sliceMs;
    if (remainingMs > 0 && !input.shouldStop()) await input.heartbeat().catch(() => undefined);
  }
}

export async function runWorkerPollingLoop(input: {
  tick: () => Promise<unknown>;
  heartbeat: () => Promise<unknown>;
  delay: (milliseconds: number) => Promise<unknown>;
  intervalMs: number;
  once: boolean;
  shouldStop: () => boolean;
  onCoordinationRetry: (backoffMs: number, consecutiveFailures: number) => void;
}) {
  let consecutiveCoordinationFailures = 0;
  do {
    try {
      await input.tick();
      consecutiveCoordinationFailures = 0;
      if (!input.once && !input.shouldStop()) await input.delay(input.intervalMs);
    } catch {
      consecutiveCoordinationFailures += 1;
      const backoffMs = coordinationBackoffMs(consecutiveCoordinationFailures, input.intervalMs);
      input.onCoordinationRetry(backoffMs, consecutiveCoordinationFailures);
      if (input.once) throw new Error("WORKER_COORDINATION_UNAVAILABLE");
      if (!input.shouldStop())
        await waitForCoordinationRetry({
          backoffMs,
          heartbeatIntervalMs: input.intervalMs,
          delay: input.delay,
          heartbeat: input.heartbeat,
          shouldStop: input.shouldStop,
        });
    }
  } while (!input.once && !input.shouldStop());
}
