import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createNarrowReplacementCredential,
  revokeNarrowReplacementCredential,
} from "../application/replacement-bootstrap-credential.ts";
import {
  authorizationChecksum,
  validateReplacementAuthorization,
} from "../integrations/mission-agent/replacement-bootstrap.ts";
import { REPLACEMENT_CREDENTIAL_PROTOCOL } from "../integrations/mission-agent/replacement-authorization-package.ts";

const authorization = validateReplacementAuthorization(
  JSON.parse(await readFile("release/mission-agent-0.7.2/replacement-bootstrap/simulation-authorization.json", "utf8")),
  { now: new Date("2026-07-28T00:00:00.000Z") },
);
const executionId = "33333333-3333-4333-8333-333333333333";

function issuanceClient(options = {}) {
  const calls = [];
  return {
    calls,
    async query(statement, values) {
      calls.push({ statement, values });
      if (statement === "BEGIN" || statement === "COMMIT" || statement === "ROLLBACK")
        return { rows: [], rowCount: null };
      if (statement.includes("replacement_bootstrap_disposable_environment_guard"))
        return {
          rows: [
            {
              database_name: "mission_control_replacement_disposable_unit",
              instance_identity: "mission-control-disposable-replacement-bootstrap-v1",
              resource_fingerprint: "f".repeat(64),
            },
          ],
          rowCount: 1,
        };
      if (statement.includes("clock_timestamp")) {
        return { rows: [{ now: new Date(options.now ?? "2026-07-28T00:00:00.000Z") }], rowCount: 1 };
      }
      if (statement.includes("FROM mission_agent_replacement_bootstraps")) {
        return {
          rows: [
            {
              state: "approved",
              authorization_checksum: authorizationChecksum(authorization),
              execution_count: 0,
              expires_at: new Date(authorization.expiresAt),
              revoked_at: null,
            },
          ],
          rowCount: 1,
        };
      }
      if (statement.includes("FROM approval_projections")) {
        return {
          rows: [
            {
              status: "granted",
              decided_by: options.approver ?? authorization.approvedBy,
              action_hash: authorizationChecksum(authorization),
              expires_at: new Date(authorization.expiresAt),
            },
          ],
          rowCount: 1,
        };
      }
      if (statement.includes("count(*)::text")) return { rows: [{ count: "0" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  };
}

test("credential issuance and execution claim are one transaction and bind exact scope", async () => {
  const client = issuanceClient();
  const issued = await createNarrowReplacementCredential({
    client,
    authorization,
    executionId,
    authenticatedApprover: authorization.approvedBy,
  });
  assert.equal(issued.executionId, executionId);
  assert.equal(issued.claimGeneration, 1);
  assert.equal(issued.authorizationFingerprint, authorizationChecksum(authorization));
  assert.equal(issued.expiresAt, authorization.expiresAt);
  assert.match(issued.scopeChecksum, /^[a-f0-9]{64}$/);
  assert.equal(
    client.calls.some((call) => call.values?.includes(JSON.stringify([REPLACEMENT_CREDENTIAL_PROTOCOL]))),
    true,
  );
  assert.equal(
    client.calls.some((call) => call.values?.includes(issued.secret)),
    false,
  );
  assert.equal(client.calls.at(-1).statement, "COMMIT");
});

test("wrong approver, expired authorization, and existing owner roll back atomically", async () => {
  await assert.rejects(
    () =>
      createNarrowReplacementCredential({
        client: issuanceClient({ approver: "other" }),
        authorization,
        executionId,
        authenticatedApprover: authorization.approvedBy,
      }),
    /atomically issuable/i,
  );
  await assert.rejects(
    () =>
      createNarrowReplacementCredential({
        client: issuanceClient({ now: "2026-08-04T00:00:00.000Z" }),
        authorization,
        executionId,
        authenticatedApprover: authorization.approvedBy,
      }),
    /expired|authorization/i,
  );
});

test("revocation locks and terminates only the exact authorization and execution scope", async () => {
  const calls = [];
  const client = {
    async query(statement, values) {
      calls.push({ statement, values });
      if (statement.includes("FROM mission_agent_replacement_credentials"))
        return { rows: [{ authorization_id: authorization.authorizationId, execution_id: executionId }], rowCount: 1 };
      return { rows: [], rowCount: statement.startsWith("UPDATE") ? 1 : null };
    },
  };
  await revokeNarrowReplacementCredential({
    client,
    workspaceId: authorization.workspaceId,
    credentialId: "22222222-2222-4222-8222-222222222222",
    authorizationId: authorization.authorizationId,
    executionId,
    now: new Date("2026-07-28T01:00:00.000Z"),
  });
  assert.equal(calls.at(-1).statement, "COMMIT");
});
