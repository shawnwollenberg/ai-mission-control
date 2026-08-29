"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { startAutoRefreshScheduler, V2_DASHBOARD_REFRESH_INTERVAL_MS } from "./auto-refresh-scheduler";

export function DashboardAutoRefresh() {
  const router = useRouter();
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date>();

  useEffect(
    () =>
      startAutoRefreshScheduler({
        visibility: document,
        timers: window,
        refresh: () => {
          router.refresh();
          setLastRefreshedAt(new Date());
        },
      }),
    [router],
  );

  return <AutoRefreshStatus lastRefreshedAt={lastRefreshedAt} />;
}

export function AutoRefreshStatus({ lastRefreshedAt }: { lastRefreshedAt?: Date }) {
  return (
    <p aria-live="polite" style={{ color: "#6b7280", fontSize: 13 }}>
      Auto-refreshes while this page is visible every {V2_DASHBOARD_REFRESH_INTERVAL_MS / 1_000} seconds
      {lastRefreshedAt ? ` · refreshed ${lastRefreshedAt.toLocaleTimeString()}` : ""}
    </p>
  );
}
