import type { PoolClient } from "pg";
import type { DomainEvent } from "@/lib/postgres-event-store";

export function missionAgentCapabilityProjectionFromEvent(event: DomainEvent) {
  if (
    !["agent.mission_agent_artifact_checksum_verified", "agent.mission_agent_artifact_checksum_rejected"].includes(
      event.eventType,
    )
  )
    return null;
  const verified = event.payload.status === "verified";
  const compatible = verified && event.payload.projectBrainCompatible === true;
  const observedAt = new Date(event.occurredAt);
  return {
    advertisedVersion: String(event.payload.advertisedVersion ?? ""),
    advertisedChecksum: event.payload.advertisedChecksum ?? null,
    expectedChecksum: event.payload.expectedChecksum ?? null,
    manifestVersion: event.payload.manifestVersion ?? null,
    checksumStatus: String(event.payload.status ?? "missing"),
    projectBrainCompatible: compatible,
    observedAt,
    heartbeatAt: observedAt,
    freshnessExpiresAt: new Date(observedAt.getTime() + 5 * 60_000),
    lastRejectionReason: event.payload.rejectionReason ?? null,
    lastVerifiedAt: compatible ? observedAt : null,
  };
}

export function missionAgentHeartbeatProjectionFromEvent(event: DomainEvent) {
  if (event.eventType !== "agent.heartbeat_received") return null;
  const artifact = event.payload.artifact as Record<string, unknown> | undefined;
  const identity = event.payload.repositoryIdentity as Record<string, unknown> | undefined;
  const repositories = Array.isArray(identity?.repositories) ? identity.repositories : [];
  const repositoryFingerprints = Object.fromEntries(
    repositories
      .filter(
        (value): value is Record<string, unknown> =>
          !!value &&
          typeof value === "object" &&
          typeof (value as Record<string, unknown>).repositoryId === "string" &&
          typeof (value as Record<string, unknown>).fingerprint === "string",
      )
      .map((value) => [String(value.repositoryId), String(value.fingerprint)]),
  );
  return {
    status: "active" as const,
    heartbeatAt: new Date(event.occurredAt),
    agentVersion: String(event.payload.missionAgentVersion ?? ""),
    artifactChecksum: String(artifact?.sha256 ?? ""),
    manifestVersion: String(artifact?.manifestVersion ?? ""),
    repositoryFingerprints,
  };
}

export async function applyMissionAgentCapabilityProjection(client: PoolClient, events: DomainEvent[]) {
  for (const event of events) {
    const projection = missionAgentCapabilityProjectionFromEvent(event);
    if (!projection) continue;
    await client.query(
      `INSERT INTO mission_agent_capability_projections(
         workspace_id,agent_id,advertised_version,advertised_checksum,expected_checksum,
         manifest_version,checksum_status,project_brain_compatible,observed_at,heartbeat_at,
         freshness_expires_at,last_rejection_reason,last_verified_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$9::timestamptz + interval '5 minutes',$10,
         CASE WHEN $8 THEN $9::timestamptz ELSE NULL END)
       ON CONFLICT(workspace_id,agent_id) DO UPDATE SET
         advertised_version=EXCLUDED.advertised_version,
         advertised_checksum=EXCLUDED.advertised_checksum,
         expected_checksum=EXCLUDED.expected_checksum,
         manifest_version=EXCLUDED.manifest_version,
         checksum_status=EXCLUDED.checksum_status,
         project_brain_compatible=EXCLUDED.project_brain_compatible,
         observed_at=EXCLUDED.observed_at,
         heartbeat_at=EXCLUDED.heartbeat_at,
         freshness_expires_at=EXCLUDED.freshness_expires_at,
         last_rejection_reason=EXCLUDED.last_rejection_reason,
         last_verified_at=EXCLUDED.last_verified_at`,
      [
        event.workspaceId,
        event.aggregateId,
        projection.advertisedVersion,
        projection.advertisedChecksum,
        projection.expectedChecksum,
        projection.manifestVersion,
        projection.checksumStatus,
        projection.projectBrainCompatible,
        projection.observedAt.toISOString(),
        projection.lastRejectionReason,
      ],
    );
  }
}
