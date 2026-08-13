import { createHash } from "node:crypto";
import {
  parseCanonicalSignedReleaseManifestV3Json,
  verifyNewProductionReleaseManifest,
  type ReleaseKeyRecord,
  type ReleaseManifestV3,
} from "@/integrations/mission-agent/release-authority";

export function acceptMissionAgentProductionRelease(input: {
  signedManifestText: string;
  artifactBytes: Uint8Array;
  artifactName: string;
  now?: Date;
  keys?: Readonly<Record<string, ReleaseKeyRecord>>;
}): ReleaseManifestV3 {
  const bundle = parseCanonicalSignedReleaseManifestV3Json(input.signedManifestText);
  const manifest = verifyNewProductionReleaseManifest(bundle, { now: input.now, keys: input.keys });
  if (manifest.compatibility.minimumMissionControlVersion !== "0.1.0")
    throw new Error("Mission Agent release requires an unsupported Mission Control version");
  if (manifest.artifactName !== input.artifactName) throw new Error("Mission Agent release artifact name mismatch");
  if (manifest.artifactByteLength !== input.artifactBytes.byteLength)
    throw new Error("Mission Agent release artifact byte-length mismatch");
  const checksum = createHash("sha256").update(input.artifactBytes).digest("hex");
  if (manifest.artifactSha256 !== checksum) throw new Error("Mission Agent release artifact checksum mismatch");
  return manifest;
}
