export function parseWorkerPid(value: string | undefined) {
  if (!value || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 1 ? parsed : undefined;
}

export function resolveWorkerPid(input: {
  recordedPid?: number;
  lockPid?: number;
  isAlive: (pid: number | undefined) => boolean;
}) {
  if (input.isAlive(input.recordedPid)) return input.recordedPid;
  if (input.isAlive(input.lockPid)) return input.lockPid;
  return undefined;
}
