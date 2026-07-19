import { PublicShell } from "../public-site";
export default function Updates() {
  return (
    <PublicShell>
      <section className="docs-hero">
        <p className="mono-kicker">Blog / Updates</p>
        <h1>
          Built through
          <br />
          daily operations.
        </h1>
        <p>Launch notes, architecture decisions, and what real agent work teaches us.</p>
      </section>
      <section className="updates-list">
        <article>
          <time>JUL 2026</time>
          <div>
            <span>Launch note</span>
            <h2>Mission Control enters production readiness</h2>
            <p>
              Durable execution, remote agents, schedules, operations, emergency controls, and the first production
              release boundary.
            </p>
          </div>
        </article>
        <article>
          <time>COMING NEXT</time>
          <div>
            <span>Field notes</span>
            <h2>The first seven days</h2>
            <p>What changes when the control plane becomes the place you actually start and review agent work.</p>
          </div>
        </article>
      </section>
    </PublicShell>
  );
}
