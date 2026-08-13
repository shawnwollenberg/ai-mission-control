import type { DisposableAcceptanceArtifact } from "@/lib/runtime-trust";
import {
  AcceptanceSourceCheckpointController,
  loadApprovedAcceptanceSource,
} from "@/lib/acceptance-source-checkpoints";

// Harness-only verification. Keep this module out of application routes so
// production output tracing never packages disposable fixtures or test source.
export function verifyMissionControlAcceptanceSource(
  artifact: DisposableAcceptanceArtifact,
  repositoryRoot = process.cwd(),
) {
  const approved = loadApprovedAcceptanceSource(artifact, repositoryRoot);
  let evidence;
  const controller = new AcceptanceSourceCheckpointController(approved, "startup-verification", (value) => {
    evidence = value;
  });
  controller.run(
    "before_mission_creation",
    {
      action: "create_consensus_mission",
      command_id: "00000000-0000-4000-8000-000000000001",
      mission_id: "00000000-0000-4000-8000-000000000002",
      repository_id: "00000000-0000-4000-8000-000000000003",
    },
    () => undefined,
  );
  if (!evidence) throw new Error("Mission Control acceptance source verification did not produce evidence");
  return {
    manifestSha256: approved.artifact.acceptanceSourceManifestSha256,
    manifestCanonicalSha256: approved.artifact.acceptanceSourceManifestCanonicalSha256,
    manifestSchemaSha256: approved.artifact.acceptanceSourceManifestSchemaSha256,
    files: approved.manifest.files,
    checkpointEvidence: evidence,
  };
}
