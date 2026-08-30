export const V2_DASHBOARD_REFRESH_INTERVAL_MS = 30_000;

type VisibilityState = "hidden" | "visible";

export interface RefreshVisibilitySource {
  visibilityState: VisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface RefreshTimerSource {
  setInterval(callback: () => void, intervalMs: number): number;
  clearInterval(timerId: number): void;
}

export function startAutoRefreshScheduler(input: {
  visibility: RefreshVisibilitySource;
  timers: RefreshTimerSource;
  refresh: () => void;
  intervalMs?: number;
}) {
  const intervalMs = input.intervalMs ?? V2_DASHBOARD_REFRESH_INTERVAL_MS;
  let timerId: number | undefined;

  const stopTimer = () => {
    if (timerId !== undefined) {
      input.timers.clearInterval(timerId);
      timerId = undefined;
    }
  };

  const startTimer = () => {
    if (timerId === undefined && input.visibility.visibilityState === "visible") {
      timerId = input.timers.setInterval(input.refresh, intervalMs);
    }
  };

  const handleVisibilityChange = () => {
    if (input.visibility.visibilityState === "hidden") {
      stopTimer();
      return;
    }

    input.refresh();
    startTimer();
  };

  input.visibility.addEventListener("visibilitychange", handleVisibilityChange);
  startTimer();

  return () => {
    stopTimer();
    input.visibility.removeEventListener("visibilitychange", handleVisibilityChange);
  };
}
