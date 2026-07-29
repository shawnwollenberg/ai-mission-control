import type { PoolClient } from "pg";
import type { DomainEvent } from "@/lib/postgres-event-store";

export async function applyMissionAgentCapabilityProjection(client: PoolClient, events: DomainEvent[]) {
  for (const event of events) {
    if (
      !["agent.mission_agent_artifact_checksum_verified", "agent.mission_agent_artifact_checksum_rejected"].includes(
        event.eventType,
      )
    )
      continue;
    const verified = event.payload.status === "verified";
    const compatible = verified && event.payload.projectBrainCompatible === true;
    await client.query(
      `INSERT INTO mission_agent_capability_projections(
         workspace_id,agent_id,advertised_version,advertised_checksum,expected_checksum,
         manifest_version,checksum_status,project_brain_compatible,observed_at,heartbeat_at,
         freshness_expires_at,last_rejection_reason,last_verified_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$9::timestamptz + interval '5 minutes',$10,
         CASE WHEN $11 THEN $9::timestamptz ELSE NULL END)
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
        String(event.payload.advertisedVersion ?? ""),
        event.payload.advertisedChecksum ?? null,
        event.payload.expectedChecksum ?? null,
        event.payload.manifestVersion ?? null,
        String(event.payload.status ?? "missing"),
        compatible,
        event.occurredAt,
        event.payload.rejectionReason ?? null,
        verified,
      ],
    );
  }
}
