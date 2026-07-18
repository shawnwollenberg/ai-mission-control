import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
export type ProcessResult = {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
};
function redact(value: string, secrets: string[]) {
  return secrets.filter(Boolean).reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), value);
}
export async function runSafeProcess(input: {
  executable: string;
  args: string[];
  cwd: string;
  allowedRoot: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  redact?: string[];
}): Promise<ProcessResult> {
  const [cwd, root] = await Promise.all([realpath(input.cwd), realpath(input.allowedRoot)]);
  if (cwd !== root && !cwd.startsWith(`${root}/`))
    throw new Error("Process working directory escapes its approved root");
  const started = Date.now(),
    limit = input.maxOutputBytes ?? 1_000_000,
    secrets = input.redact ?? [];
  return new Promise((resolve, reject) => {
    let stdout = "",
      stderr = "",
      timedOut = false,
      cancelled = false,
      settled = false;
    const childEnv: NodeJS.ProcessEnv = {
      NODE_ENV: process.env.NODE_ENV ?? "production",
      PATH: input.env?.PATH ?? process.env.PATH ?? "/usr/bin:/bin",
      LANG: input.env?.LANG ?? "C.UTF-8",
      LC_ALL: input.env?.LC_ALL ?? "C.UTF-8",
      ...(input.env?.CODEX_HOME ? { CODEX_HOME: input.env.CODEX_HOME } : {}),
    };
    const child = spawn(input.executable, input.args, {
      cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const append = (current: string, chunk: Buffer) =>
      redact((current + chunk.toString("utf8")).slice(0, limit), secrets);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", reject);
    const stop = () => {
      cancelled = true;
      child.kill("SIGTERM");
    };
    input.signal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
    }, input.timeoutMs);
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", stop);
      resolve({ exitCode, signal, stdout, stderr, timedOut, cancelled, durationMs: Date.now() - started });
    });
    if (input.stdin) child.stdin.end(input.stdin);
    else child.stdin.end();
  });
}
