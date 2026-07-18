import { compare } from "bcryptjs";
import { cookies } from "next/headers";
import type { Pool, PoolClient } from "pg";
import { getDatabasePool } from "@/lib/database";
import { SESSION_COOKIE_NAME, verifySessionToken, type SessionIdentity } from "@/lib/session";

type AuthenticatedOwnerRow = {
  user_id: string;
  workspace_id: string;
  email: string;
  password_hash: string;
  auth_version: number;
  role: "owner" | "member";
};

async function findActiveMembership(client: Pool | PoolClient, email: string) {
  const result = await client.query<AuthenticatedOwnerRow>(
    `SELECT u.id AS user_id, wm.workspace_id, u.email, u.password_hash, u.auth_version, wm.role
     FROM users u
     JOIN workspace_memberships wm ON wm.user_id = u.id
     WHERE lower(u.email) = lower($1) AND u.disabled_at IS NULL
     ORDER BY CASE wm.role WHEN 'owner' THEN 0 ELSE 1 END, wm.created_at
     LIMIT 1`,
    [email.trim()],
  );
  return result.rows[0];
}

export async function authenticateOwner(email: string, password: string): Promise<SessionIdentity | undefined> {
  const owner = await findActiveMembership(getDatabasePool(), email);
  if (!owner || !(await compare(password, owner.password_hash))) return undefined;
  return {
    userId: owner.user_id,
    workspaceId: owner.workspace_id,
    role: owner.role,
    email: owner.email,
    authVersion: owner.auth_version,
  };
}

export async function getSessionIdentity(): Promise<SessionIdentity | undefined> {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (!token) return undefined;
  const identity = await verifySessionToken(token);
  if (!identity) return undefined;
  const active = await findActiveMembership(getDatabasePool(), identity.email);
  if (
    !active ||
    active.user_id !== identity.userId ||
    active.workspace_id !== identity.workspaceId ||
    active.role !== identity.role ||
    active.auth_version !== identity.authVersion
  ) {
    return undefined;
  }
  return identity;
}

export function requireSameOrigin(request: Request): void {
  const expected = new URL(process.env.PUBLIC_APP_URL ?? request.url).origin;
  const origin = request.headers.get("origin");
  if (!origin || origin !== expected) throw new Error("Invalid request origin");
}
