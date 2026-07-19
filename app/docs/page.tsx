import Link from "next/link";
import { docGroups, PublicShell } from "../public-site";
export default function DocsPage() {
  return (
    <PublicShell>
      <section className="docs-hero">
        <p className="mono-kicker">Documentation</p>
        <h1>
          Build your AI organization
          <br />
          on solid ground.
        </h1>
        <p>Start with one agent and one bounded mission. Add capability only after the evidence earns it.</p>
      </section>
      <section className="docs-index">
        {docGroups.map((group) => (
          <div className="docs-group" key={group.title}>
            <h2>{group.title}</h2>
            {group.items.map(([label, href], i) => (
              <Link href={href} key={label}>
                <span>{String(i + 1).padStart(2, "0")}</span>
                {label}
                <b>→</b>
              </Link>
            ))}
          </div>
        ))}
      </section>
    </PublicShell>
  );
}
