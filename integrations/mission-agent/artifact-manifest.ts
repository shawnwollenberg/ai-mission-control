export type MissionAgentArtifactVerification = {
  advertisedChecksum: string | null;
  expectedChecksum: string | null;
  manifestVersion: string | null;
  status: "verified" | "missing" | "malformed" | "unapproved_version" | "mismatch";
  compatible: boolean;
  rejectionReason: string | null;
};

// Generated from the detached release manifest after the immutable artifact is
// finalized. The checksum covers the exact public .mjs bytes, not configuration
// or runtime state.
export const approvedMissionAgentArtifacts: Readonly<Record<string, { sha256: string; manifestVersion: "1" | "3" }>> = {
  "0.6.8": {
    sha256: "e6cdf9d962231844b1887959411a8d262bf9371092eb0e789a4971ba3c3fc28d",
    manifestVersion: "1",
  },
  "0.7.2": {
    sha256: "108e5587e8ffce0c37639e041cd2dcc2b51079f395beb04b26c1d4d9330bee09",
    manifestVersion: "3",
  },
};

export function verifyMissionAgentArtifact(version: unknown, artifact: unknown): MissionAgentArtifactVerification {
  const candidate =
    artifact && typeof artifact === "object" && !Array.isArray(artifact) ? (artifact as Record<string, unknown>) : {};
  const advertisedChecksum = typeof candidate.sha256 === "string" ? candidate.sha256 : null;
  const manifestVersion = typeof candidate.manifestVersion === "string" ? candidate.manifestVersion : null;
  const approved = typeof version === "string" ? approvedMissionAgentArtifacts[version] : undefined;
  const expectedChecksum = approved?.sha256 ?? null;
  if (!advertisedChecksum)
    return {
      advertisedChecksum,
      expectedChecksum,
      manifestVersion,
      status: "missing",
      compatible: false,
      rejectionReason: "mission_agent_artifact_checksum_missing",
    };
  if (!/^[a-f0-9]{64}$/.test(advertisedChecksum) || !["1", "3"].includes(String(manifestVersion)))
    return {
      advertisedChecksum,
      expectedChecksum,
      manifestVersion,
      status: "malformed",
      compatible: false,
      rejectionReason: "mission_agent_artifact_identity_malformed",
    };
  if (!approved)
    return {
      advertisedChecksum,
      expectedChecksum,
      manifestVersion,
      status: "unapproved_version",
      compatible: false,
      rejectionReason: "mission_agent_version_unapproved",
    };
  if (manifestVersion !== approved.manifestVersion)
    return {
      advertisedChecksum,
      expectedChecksum,
      manifestVersion,
      status: "malformed",
      compatible: false,
      rejectionReason: "mission_agent_artifact_identity_malformed",
    };
  if (advertisedChecksum !== approved.sha256)
    return {
      advertisedChecksum,
      expectedChecksum,
      manifestVersion,
      status: "mismatch",
      compatible: false,
      rejectionReason: "mission_agent_artifact_checksum_mismatch",
    };
  return {
    advertisedChecksum,
    expectedChecksum,
    manifestVersion,
    status: "verified",
    compatible: true,
    rejectionReason: null,
  };
}
