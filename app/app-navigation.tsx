"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { BrandSprite } from "@/app/brand-assets";

const secondaryLinks = [
  { href: "/templates", label: "Templates" },
  { href: "/operations", label: "Operations" },
  { href: "/schedules", label: "Schedules" },
  { href: "/notifications", label: "Notifications" },
  { href: "/audit", label: "Governance audit" },
  { href: "/operations/dead-letters", label: "Dead-letter jobs" },
] as const;

function isCurrentPath(pathname: string, href: string) {
  return href === "/" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

function navigationClass(active: boolean, launch = false) {
  return `nav-link${launch ? " nav-link-launch" : ""}${active ? " is-active" : ""}`;
}

type MissionNavigationMission = {
  missionId: string;
  name: string;
  status: string;
  priority: string;
  riskLevel: string;
  updatedAt: string;
  pendingApprovals: number;
  blockedTasks: number;
  failedTasks: number;
};

type MissionNavigationSnapshot = {
  activeMissions: number;
  attentionMissions: number;
  pendingApprovals: number;
  missions: MissionNavigationMission[];
};

export function AppNavigation({ subtitle }: { subtitle: string }) {
  return (
    <nav className="brandbar app-navigation" aria-label="Primary navigation">
      <Link className="app-navigation-brand" href="/" aria-label="Mission Control home">
        <BrandSprite asset="mark-compact" />
        <span>
          <span className="eyebrow">Mission Control</span>
          <span className="brand-subtitle">{subtitle}</span>
        </span>
      </Link>
      <AppNavigationLinks />
    </nav>
  );
}

function AppNavigationLinks() {
  const pathname = usePathname();
  const secondaryActive = secondaryLinks.some((link) => isCurrentPath(pathname, link.href));

  return (
    <div className="app-navigation-links">
      <Link
        className={navigationClass(isCurrentPath(pathname, "/"), true)}
        href="/"
        aria-current={isCurrentPath(pathname, "/") ? "page" : undefined}
      >
        New Mission
      </Link>
      <Link
        className={navigationClass(isCurrentPath(pathname, "/missions"))}
        href="/missions"
        aria-current={isCurrentPath(pathname, "/missions") ? "page" : undefined}
      >
        Missions
      </Link>
      <MissionSwitcher pathname={pathname} />
      <Link
        className={navigationClass(isCurrentPath(pathname, "/repositories"))}
        href="/repositories"
        aria-current={isCurrentPath(pathname, "/repositories") ? "page" : undefined}
      >
        Repositories
      </Link>
      <Link
        className={navigationClass(isCurrentPath(pathname, "/agents"))}
        href="/agents"
        aria-current={isCurrentPath(pathname, "/agents") ? "page" : undefined}
      >
        Agents
      </Link>
      <Link
        className={navigationClass(isCurrentPath(pathname, "/approvals"))}
        href="/approvals"
        aria-current={isCurrentPath(pathname, "/approvals") ? "page" : undefined}
      >
        Approvals
      </Link>
      <details className="app-navigation-more" open={secondaryActive}>
        <summary className={`nav-link nav-more-summary${secondaryActive ? " is-active" : ""}`}>More</summary>
        <div className="app-navigation-more-menu">
          {secondaryLinks.map((link) => {
            const active = isCurrentPath(pathname, link.href);
            return (
              <Link
                className={`nav-link${active ? " is-active" : ""}`}
                href={link.href}
                key={link.href}
                aria-current={active ? "page" : undefined}
              >
                {link.label}
              </Link>
            );
          })}
        </div>
      </details>
      <a className="nav-link nav-link-logout" href="/logout">
        Log out
      </a>
    </div>
  );
}

function MissionSwitcher({ pathname }: { pathname: string }) {
  const [snapshot, setSnapshot] = useState<MissionNavigationSnapshot>();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch("/api/navigation/mission-summary", { cache: "no-store" });
        if (!response.ok || cancelled) return;
        setSnapshot((await response.json()) as MissionNavigationSnapshot);
      } catch {
        // Navigation remains useful when the live summary is temporarily unavailable.
      }
    }
    void load();
    const interval = window.setInterval(load, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  return (
    <details className="mission-switcher">
      <summary className="mission-switcher-summary">
        <span>Switch mission</span>
        <strong aria-live="polite">{snapshot ? snapshot.activeMissions : "—"}</strong>
        {snapshot?.attentionMissions ? (
          <b aria-label={`${snapshot.attentionMissions} missions need attention`}>{snapshot.attentionMissions}</b>
        ) : null}
      </summary>
      <div className="mission-switcher-menu">
        <div className="mission-switcher-heading">
          <div>
            <span className="section-label">Live command queue</span>
            <strong>{snapshot ? `${snapshot.activeMissions} active` : "Loading missions…"}</strong>
          </div>
          {snapshot?.pendingApprovals ? <small>{snapshot.pendingApprovals} approvals pending</small> : null}
        </div>
        {snapshot?.missions.length ? (
          <div className="mission-switcher-list">
            {snapshot.missions.map((mission) => {
              const needsAttention =
                mission.pendingApprovals > 0 ||
                mission.blockedTasks > 0 ||
                mission.failedTasks > 0 ||
                mission.status === "paused" ||
                mission.status === "failed";
              const reason = mission.pendingApprovals
                ? `${mission.pendingApprovals} approval${mission.pendingApprovals === 1 ? "" : "s"} pending`
                : mission.blockedTasks
                  ? `${mission.blockedTasks} blocked task${mission.blockedTasks === 1 ? "" : "s"}`
                  : mission.failedTasks
                    ? `${mission.failedTasks} failed task${mission.failedTasks === 1 ? "" : "s"}`
                    : mission.status === "paused"
                      ? "Paused"
                      : mission.status === "failed"
                        ? "Failed"
                        : `${mission.priority} priority`;
              return (
                <Link
                  className={`mission-switcher-item${mission.missionId === pathname.split("/").at(-1) ? " is-current" : ""}`}
                  href={`/missions/${mission.missionId}`}
                  key={mission.missionId}
                >
                  <span className={`mission-switcher-dot mission-switcher-dot-${mission.status}`} aria-hidden="true" />
                  <span className="mission-switcher-item-copy">
                    <strong>{mission.name}</strong>
                    <small>
                      {mission.status} · {reason} ·{" "}
                      {new Date(mission.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </small>
                  </span>
                  {needsAttention ? <b className="mission-switcher-attention">!</b> : null}
                </Link>
              );
            })}
          </div>
        ) : (
          <p className="mission-switcher-empty">No missions have been created yet.</p>
        )}
        <Link className="mission-switcher-all" href="/missions">
          Open mission operations →
        </Link>
      </div>
    </details>
  );
}
