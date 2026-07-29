export type MissionAgentArtifactVerification = {
  advertisedChecksum: string | null;
  expectedChecksum: string | null;
  manifestVersion: string | null;
  status: "verified" | "missing" | "malformed" | "unapproved_version" | "mismatch";
  compatible: boolean;
  identityProtocolVersion: string | null;
  rejectionReason: string | null;
};

// Generated from the detached release manifest after the immutable artifact is
// finalized. The checksum covers the exact public .mjs bytes, not configuration
// or runtime state.
type ApprovedMissionAgentArtifact = {
  sha256: string;
  manifestVersion: "1" | "3";
  identityProtocolVersion: "1" | "2";
  releaseAuthorityVersion?: "v2";
  signingKeyId?: string;
  publicKeyFingerprint?: string;
};

export const approvedMissionAgentArtifacts: Readonly<Record<string, ApprovedMissionAgentArtifact>> = {
  "0.6.8": {
    sha256: "e6cdf9d962231844b1887959411a8d262bf9371092eb0e789a4971ba3c3fc28d",
    manifestVersion: "1",
    identityProtocolVersion: "1",
  },
  "0.7.2": {
    sha256: "108e5587e8ffce0c37639e041cd2dcc2b51079f395beb04b26c1d4d9330bee09",
    manifestVersion: "3",
    identityProtocolVersion: "2",
    releaseAuthorityVersion: "v2",
    signingKeyId: "mission-agent-release-2026-01",
    publicKeyFingerprint: "ed25519-spki-sha256:7943a55a297cd50faf0a5841d06bcd0046d84dab73cc83543ba4021520706e8b",
  },
};

export function verifyMissionAgentArtifact(version: unknown, artifact: unknown): MissionAgentArtifactVerification {
  const candidate =
    artifact && typeof artifact === "object" && !Array.isArray(artifact) ? (artifact as Record<string, unknown>) : {};
  const advertisedChecksum = typeof candidate.sha256 === "string" ? candidate.sha256 : null;
  const manifestVersion = typeof candidate.manifestVersion === "string" ? candidate.manifestVersion : null;
  const approved = typeof version === "string" ? approvedMissionAgentArtifacts[version] : undefined;
  const expectedChecksum = approved?.sha256 ?? null;
  const identityProtocolVersion = approved?.identityProtocolVersion ?? null;
  if (!advertisedChecksum)
    return {
      advertisedChecksum,
      expectedChecksum,
      manifestVersion,
      status: "missing",
      compatible: false,
      identityProtocolVersion,
      rejectionReason: "mission_agent_artifact_checksum_missing",
    };
  if (!/^[a-f0-9]{64}$/.test(advertisedChecksum) || !["1", "3"].includes(manifestVersion ?? ""))
    return {
      advertisedChecksum,
      expectedChecksum,
      manifestVersion,
      status: "malformed",
      compatible: false,
      identityProtocolVersion,
      rejectionReason: "mission_agent_artifact_identity_malformed",
    };
  if (!approved)
    return {
      advertisedChecksum,
      expectedChecksum,
      manifestVersion,
      status: "unapproved_version",
      compatible: false,
      identityProtocolVersion,
      rejectionReason: "mission_agent_version_unapproved",
    };
  if (
    advertisedChecksum !== approved.sha256 ||
    manifestVersion !== approved.manifestVersion ||
    (approved.manifestVersion === "3" &&
      (candidate.releaseAuthorityVersion !== approved.releaseAuthorityVersion ||
        candidate.signingKeyId !== approved.signingKeyId ||
        candidate.publicKeyFingerprint !== approved.publicKeyFingerprint))
  )
    return {
      advertisedChecksum,
      expectedChecksum,
      manifestVersion,
      status: "mismatch",
      compatible: false,
      identityProtocolVersion,
      rejectionReason: "mission_agent_artifact_checksum_mismatch",
    };
  return {
    advertisedChecksum,
    expectedChecksum,
    manifestVersion,
    status: "verified",
    compatible: true,
    identityProtocolVersion,
    rejectionReason: null,
  };
}
