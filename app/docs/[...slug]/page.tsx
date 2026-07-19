import { notFound } from "next/navigation";
import { docs, docGroups, PublicShell } from "../../public-site";
import Link from "next/link";
export default async function DocPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const key = (await params).slug.join("/"),
    doc = docs[key];
  if (!doc) notFound();
  return (
    <PublicShell>
      <div className="doc-layout">
        <aside>
          <Link href="/docs">Documentation</Link>
          {docGroups.map((g) => (
            <div key={g.title}>
              <strong>{g.title}</strong>
              {g.items.map(([label, href]) => (
                <Link className={href === `/docs/${key}` ? "active" : ""} href={href} key={label}>
                  {label}
                </Link>
              ))}
            </div>
          ))}
        </aside>
        <article className="doc-article">
          <p className="mono-kicker">{doc.eyebrow}</p>
          <h1>{doc.title}</h1>
          <p className="doc-lede">{doc.lede}</p>
          {doc.sections.map((section) => (
            <section key={section.title}>
              <h2>{section.title}</h2>
              <p>{section.body}</p>
            </section>
          ))}
          <div className="doc-next">
            <span>Next step</span>
            <Link href="/quick-start">
              Quick Start <b>→</b>
            </Link>
          </div>
        </article>
      </div>
    </PublicShell>
  );
}
