import Link from "next/link";
import { PublicShell } from "../public-site";
export default function Examples() {
  return (
    <PublicShell>
      <section className="docs-hero">
        <p className="mono-kicker">Examples</p>
        <h1>
          Start with work
          <br />
          you can verify.
        </h1>
      </section>
      <section className="example-grid">
        {[
          [
            "Daily health report",
            "Hermes reviews workers, schedules, failures, and budgets, then produces a read-only report.",
          ],
          [
            "Bounded code change",
            "Codex edits an isolated worktree, runs tests, and creates a local commit. Push and PR remain separate approvals.",
          ],
          [
            "Read-only portfolio review",
            "Hermes analyzes approved market and portfolio data without signing or submitting a transaction.",
          ],
          [
            "Mixed implementation",
            "Hermes recommends a change, a human approves the handoff, and Codex implements within repository limits.",
          ],
        ].map(([t, d]) => (
          <article key={t}>
            <span>LIVE PATTERN</span>
            <h2>{t}</h2>
            <p>{d}</p>
            <Link href="/docs">View guide →</Link>
          </article>
        ))}
      </section>
    </PublicShell>
  );
}
