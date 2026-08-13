export async function waitForAcceptanceServerReadiness(input: {
  pid: number;
  healthUrl: string;
  attempts?: number;
  delayMs?: number;
  processAlive?: (pid: number) => boolean;
  fetchHealth?: (url: string) => Promise<boolean>;
}) {
  const processAlive =
    input.processAlive ??
    ((pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
  const fetchHealth =
    input.fetchHealth ??
    ((url: string) =>
      fetch(url)
        .then((response) => response.ok)
        .catch(() => false));
  for (let attempt = 0; attempt < (input.attempts ?? 150); attempt += 1) {
    if (!processAlive(input.pid)) throw new Error("Restarted server exited before readiness");
    if (await fetchHealth(input.healthUrl)) return;
    await new Promise((done) => setTimeout(done, input.delayMs ?? 100));
  }
  throw new Error("Restarted server did not become ready before identity observation");
}
