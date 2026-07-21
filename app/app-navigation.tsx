import Link from "next/link";
import { BrandSprite } from "@/app/brand-assets";

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
      <div className="app-navigation-links">
        <Link className="nav-link" href="/">
          New Mission
        </Link>
        <Link className="nav-link" href="/missions">
          Missions
        </Link>
        <Link className="nav-link" href="/agents">
          Agents
        </Link>
        <Link className="nav-link" href="/approvals">
          Approvals
        </Link>
        <Link className="nav-link" href="/templates">
          Templates
        </Link>
        <Link className="nav-link" href="/operations">
          Operations
        </Link>
        <a className="nav-link" href="/logout">
          Log out
        </a>
      </div>
    </nav>
  );
}
