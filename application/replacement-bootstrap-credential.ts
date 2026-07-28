import type { PoolClient } from "pg";
import { REPLACEMENT_CREDENTIAL_PROTOCOL } from "../integrations/mission-agent/replacement-authorization-package";

export {
  issueReplacementCredentialAndClaim as createNarrowReplacementCredential,
  type IssuedReplacementCredential as ReplacementCredentialIssue,
} from "./replacement-bootstrap-governance";

export async function revokeNarrowReplacementCredential(input: {
  client: PoolClient;
  workspaceId: string;
  credentialId: string;
  authorizationId: string;
  executionId: string;
  now: Date;
}): Promise<void> {
  await input.client.query("BEGIN");
  try {
    const scope = await input.client.query<{ authorization_id: string; execution_id: string }>(
      `SELECT authorization_id,execution_id
         FROM mission_agent_replacement_credentials
        WHERE workspace_id=$1 AND credential_id=$2
          AND authorization_id=$3 AND execution_id=$4
          AND revoked_at IS NULL AND consumed_at IS NULL
        FOR UPDATE`,
      [input.workspaceId, input.credentialId, input.authorizationId, input.executionId],
    );
    if (!scope.rows[0]) throw new Error("Narrow replacement credential scope is unavailable or terminal.");
    const result = await input.client.query(
      `UPDATE agent_credentials
          SET status='revoked',revoked_at=$3
        WHERE workspace_id=$1 AND credential_id=$2
          AND allowed_protocol_versions=$4::jsonb AND status='active'`,
      [
        input.workspaceId,
        input.credentialId,
        input.now.toISOString(),
        JSON.stringify([REPLACEMENT_CREDENTIAL_PROTOCOL]),
      ],
    );
    if (result.rowCount !== 1) throw new Error("Narrow replacement credential was unavailable.");
    await input.client.query(
      `UPDATE mission_agent_replacement_credentials SET revoked_at=$3
        WHERE workspace_id=$1 AND credential_id=$2`,
      [input.workspaceId, input.credentialId, input.now.toISOString()],
    );
    await input.client.query("COMMIT");
  } catch (error) {
    await input.client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
