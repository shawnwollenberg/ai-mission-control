import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePageIdentity } from "@/lib/page-auth";
import { readExecutionArtifact } from "@/execution/artifact-store";

export const dynamic = "force-dynamic";
export default async function ArtifactPage({ params }: { params: Promise<{ artifactId: string }> }) {
  const identity = await requirePageIdentity("/artifacts");
  const { artifactId } = await params;
  const artifact = await readExecutionArtifact(identity.workspaceId, artifactId);
  if (!artifact) notFound();
  const metadata = artifact.metadata as Record<string, unknown>;
  const displayBody = artifact.body
    .toString("utf8")
    .replace(/\/(?:Users|home)\/[^)\s]+\/mission-control(?=\/|[)\s])/g, "[repository]")
    .replace(/[A-Za-z]:\\Users\\[^)\s]+\\mission-control(?=\\|[)\s])/g, "[repository]");
  return (
    <main className="archive-shell">
      <nav className="brandbar">
        <Link className="nav-link" href={`/missions/${metadata.mission_id}`}>
          ← Mission
        </Link>
        <Link className="nav-link" href="/missions">
          Mission archive
        </Link>
      </nav>
      <header className="archive-header">
        <div>
          <p className="section-label">Live execution artifact</p>
          <h1>{String((metadata.metadata as Record<string, unknown>)?.name ?? metadata.kind)}</h1>
          <p>
            {String((metadata.metadata as Record<string, unknown>)?.description ?? "Verified Mission Control artifact")}
          </p>
        </div>
      </header>
      <section className="panel">
        <p className="section-label">
          Checksum · {String(metadata.checksum_sha256).slice(0, 16)} · {String(metadata.byte_size)} bytes
        </p>
        <pre className="artifact-body">{displayBody}</pre>
      </section>
    </main>
  );
}
