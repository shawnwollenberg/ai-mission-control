export function assertProcessSignalAuthority(args: {
  pid: number;
  currentPid: number;
  expectedIdentity: string | undefined;
  observedIdentity: string | null;
  processKind: "process" | "process_group";
}) {
  if (!Number.isSafeInteger(args.pid) || args.pid <= 1 || args.pid === args.currentPid)
    throw new Error(`Invalid disposable ${args.processKind} identity`);
  if (!args.expectedIdentity || !/^[a-f0-9]{64}$/.test(args.expectedIdentity))
    throw new Error(`Authoritative disposable ${args.processKind} identity is missing`);
  if (args.observedIdentity !== args.expectedIdentity)
    throw new Error(`Possible PID reuse for disposable ${args.processKind}; refusing signal`);
  return true;
}

export async function confirmTerminalQuiescence(
  probeAlive: () => boolean | Promise<boolean>,
  wait: () => Promise<void>,
  requiredConsecutiveAbsent = 3,
) {
  let absent = 0;
  for (let attempt = 0; attempt < requiredConsecutiveAbsent * 2 && absent < requiredConsecutiveAbsent; attempt += 1) {
    if (await probeAlive()) absent = 0;
    else absent += 1;
    if (absent < requiredConsecutiveAbsent) await wait();
  }
  return absent === requiredConsecutiveAbsent;
}

export async function awaitBoundedProcessGroupExit(args: {
  leaderExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  timeoutMs: number;
  signalGroup: (signal: NodeJS.Signals) => void;
  groupAlive: () => boolean;
  wait?: (milliseconds: number) => Promise<void>;
  graceMs?: number;
}) {
  const wait =
    args.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const graceMs = args.graceMs ?? 500;
  let result: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const observedExit = args.leaderExit.then((value) => {
    result = value;
    return true;
  });
  let deadlineTimer: NodeJS.Timeout | undefined;
  const deadline = args.wait
    ? wait(args.timeoutMs).then(() => false)
    : new Promise<false>((resolve) => {
        deadlineTimer = setTimeout(() => resolve(false), args.timeoutMs);
      });
  const exitedBeforeDeadline = await Promise.race([observedExit, deadline]).finally(() => {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  });
  const timedOut = !exitedBeforeDeadline;

  if (args.groupAlive()) {
    args.signalGroup("SIGTERM");
    await Promise.race([observedExit, wait(graceMs)]);
  }
  if (args.groupAlive()) {
    args.signalGroup("SIGKILL");
    await Promise.race([observedExit, wait(graceMs)]);
  }
  const quiescent = await confirmTerminalQuiescence(args.groupAlive, () => wait(50));
  if (!quiescent) throw new Error("Disposable process group did not terminate after bounded SIGTERM/SIGKILL");
  if (!result) await Promise.race([observedExit, wait(graceMs)]);
  if (!result) throw new Error("Disposable process leader did not report exit after bounded SIGTERM/SIGKILL");
  return { ...result, timedOut };
}

export function planProcessGroupCleanup(args: {
  groupAlive: boolean;
  leaderPid: number;
  expectedLeaderIdentity: string;
  observedLeaderIdentity: string | null;
  persistedDescendants?: readonly { pid: number; identity: string }[];
  observedDescendants?: readonly { pid: number; identity: string }[];
}) {
  if (!args.groupAlive) return { action: "already_vanished" as const, pids: [] as number[] };
  if (args.observedLeaderIdentity === args.expectedLeaderIdentity)
    return { action: "signal_process_group" as const, pids: [args.leaderPid] };
  if (args.observedLeaderIdentity)
    return { action: "fail_unsafe_identity" as const, pids: [] as number[], reason: "leader_identity_reused" };
  const expected = new Map((args.persistedDescendants ?? []).map((member) => [member.pid, member.identity]));
  const observed = args.observedDescendants ?? [];
  if (!observed.length)
    return { action: "fail_unsafe_identity" as const, pids: [] as number[], reason: "orphan_group_ambiguous" };
  if (observed.some((member) => expected.get(member.pid) !== member.identity))
    return { action: "fail_unsafe_identity" as const, pids: [] as number[], reason: "descendant_identity_ambiguous" };
  return { action: "signal_proven_descendants" as const, pids: observed.map((member) => member.pid) };
}

export async function cleanupReservedPath(args: {
  intendedPath: string;
  acceptanceRoot: string;
  remove: (path: string) => Promise<void>;
  exists: (path: string) => Promise<boolean>;
}) {
  const { resolve, sep } = await import("node:path");
  const path = resolve(args.intendedPath);
  const root = resolve(args.acceptanceRoot);
  if (path === root || !path.startsWith(`${root}${sep}`)) throw new Error("Reserved cleanup path escapes root");
  await args.remove(path);
  return { path, deleted: !(await args.exists(path)) };
}
