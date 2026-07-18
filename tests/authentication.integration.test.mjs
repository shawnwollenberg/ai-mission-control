import assert from "node:assert/strict";
import test from "node:test";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
process.env.MISSION_CONTROL_SESSION_SECRET =
  process.env.MISSION_CONTROL_SESSION_SECRET ??
  "integration-current-session-key-0001,integration-previous-session-key-0002";

const { authenticateOwner } = await import("../lib/authentication.ts");
const { closeDatabasePool, getDatabasePool } = await import("../lib/database.ts");
const { DEFAULT_OWNER_ID, DEFAULT_WORKSPACE_ID } = await import("../lib/identity-constants.ts");
const { createSessionToken, verifySessionToken } = await import("../lib/session.ts");
const { seedDatabase } = await import("../scripts/seed.ts");

test.after(closeDatabasePool);

test("owner seed is idempotent and does not replace credentials", async () => {
  const before = await getDatabasePool().query(
    "SELECT password_hash, display_name FROM users WHERE id = $1 AND email = $2",
    [DEFAULT_OWNER_ID, "owner@example.com"],
  );
  assert.equal(before.rowCount, 1);

  const result = await seedDatabase({
    email: "owner@example.com",
    displayName: "Unexpected Replacement",
    passwordHash: "$2b$12$G7wG1dUqBBuTNkMjeTjU2eYvNCPQb2Ph5f1b.W/pRzM7iLj1FT5lG",
  });
  assert.deepEqual(result, { workspaceCreated: false, ownerCreated: false, membershipCreated: false });

  const after = await getDatabasePool().query(
    `SELECT u.password_hash, u.display_name, wm.role
     FROM users u JOIN workspace_memberships wm ON wm.user_id = u.id
     WHERE u.id = $1 AND wm.workspace_id = $2`,
    [DEFAULT_OWNER_ID, DEFAULT_WORKSPACE_ID],
  );
  assert.equal(after.rows[0].password_hash, before.rows[0].password_hash);
  assert.equal(after.rows[0].display_name, before.rows[0].display_name);
  assert.equal(after.rows[0].role, "owner");
});

test("configured owner authenticates and an invalid password is rejected", async () => {
  assert.equal((await authenticateOwner("owner@example.com", "mission-control-local-test"))?.role, "owner");
  assert.equal(await authenticateOwner("owner@example.com", "wrong-password"), undefined);
});

test("jose session round-trip preserves workspace identity and rejects tampering", async () => {
  const identity = {
    userId: DEFAULT_OWNER_ID,
    workspaceId: DEFAULT_WORKSPACE_ID,
    role: "owner",
    email: "owner@example.com",
    authVersion: 1,
  };
  const token = await createSessionToken(identity);
  assert.deepEqual(await verifySessionToken(token), identity);
  const parts = token.split(".");
  parts[2] = `${parts[2][0] === "a" ? "b" : "a"}${parts[2].slice(1)}`;
  assert.equal(await verifySessionToken(parts.join(".")), undefined);
});
