import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { assertAssignmentLeaseAuthority } from "../application/pull-assignments.ts";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const originalToken = `mc_lease_${"a".repeat(43)}`;
const replacementToken = `mc_lease_${"b".repeat(43)}`;
const reclaimed = {
  lease_owner: "mission-agent-restarted",
  lease_token_hash: hash(replacementToken),
  lease_expires_at: new Date(Date.now() + 60_000),
  fencing_token: 8,
  payload: { missionType: "consensus_plan" },
};

test("reclaim rejects the original lease credential and old fencing while accepting replacement authority", () => {
  assert.throws(
    () =>
      assertAssignmentLeaseAuthority(
        { leaseOwner: "mission-agent-original", leaseToken: originalToken, fencingToken: 7 },
        reclaimed,
      ),
    (error) => {
      assert.equal(error.code, "validation_failed");
      assert.equal(error.details.reason_code, "ASSIGNMENT_LEASE_LOST");
      return true;
    },
  );
  assert.throws(
    () =>
      assertAssignmentLeaseAuthority(
        { leaseOwner: "mission-agent-restarted", leaseToken: replacementToken, fencingToken: 7 },
        reclaimed,
      ),
    /fencing token is stale/,
  );
  assert.doesNotThrow(() =>
    assertAssignmentLeaseAuthority(
      { leaseOwner: "mission-agent-restarted", leaseToken: replacementToken, fencingToken: 8 },
      reclaimed,
    ),
  );
});

test("provider-child retry keeps the same Mission Agent lease and fence authoritative", () => {
  const active = {
    lease_owner: "mission-agent-active",
    lease_token_hash: hash(originalToken),
    lease_expires_at: new Date(Date.now() + 60_000),
    fencing_token: 7,
    payload: { missionType: "consensus_plan" },
  };
  assert.doesNotThrow(() =>
    assertAssignmentLeaseAuthority(
      { leaseOwner: "mission-agent-active", leaseToken: originalToken, fencingToken: 7 },
      active,
    ),
  );
  assert.throws(
    () =>
      assertAssignmentLeaseAuthority(
        { leaseOwner: "mission-agent-active", leaseToken: originalToken, fencingToken: 8 },
        active,
      ),
    /fencing token is stale/,
  );
});
