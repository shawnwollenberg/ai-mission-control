import { jwtVerify, SignJWT, type JWTPayload } from "jose";

export const SESSION_COOKIE_NAME = "mission_control_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 8;

export type SessionIdentity = {
  userId: string;
  workspaceId: string;
  role: "owner" | "member";
  email: string;
  authVersion: number;
};

type SessionPayload = JWTPayload & {
  workspaceId: string;
  role: SessionIdentity["role"];
  email: string;
  authVersion: number;
};

function sessionSecrets(): Uint8Array[] {
  const configured = process.env.MISSION_CONTROL_SESSION_SECRET?.split(",")
    .map((secret) => secret.trim())
    .filter(Boolean);
  if (!configured?.length || configured.some((secret) => secret.length < 32)) {
    throw new Error(
      "MISSION_CONTROL_SESSION_SECRET must contain one or more comma-separated secrets of at least 32 characters",
    );
  }
  return configured.map((secret) => new TextEncoder().encode(secret));
}

export async function createSessionToken(identity: SessionIdentity): Promise<string> {
  const [signingKey] = sessionSecrets();
  return new SignJWT({
    workspaceId: identity.workspaceId,
    role: identity.role,
    email: identity.email,
    authVersion: identity.authVersion,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(identity.userId)
    .setIssuer("mission-control")
    .setAudience("mission-control-web")
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(signingKey);
}

export async function verifySessionToken(token: string): Promise<SessionIdentity | undefined> {
  for (const key of sessionSecrets()) {
    try {
      const verified = await jwtVerify(token, key, {
        algorithms: ["HS256"],
        issuer: "mission-control",
        audience: "mission-control-web",
      });
      const payload = verified.payload as SessionPayload;
      if (
        !payload.sub ||
        !payload.workspaceId ||
        !payload.email ||
        !Number.isInteger(payload.authVersion) ||
        (payload.role !== "owner" && payload.role !== "member")
      ) {
        return undefined;
      }
      return {
        userId: payload.sub,
        workspaceId: payload.workspaceId,
        role: payload.role,
        email: payload.email,
        authVersion: payload.authVersion,
      };
    } catch {
      // Try older verification keys during rotation.
    }
  }
  return undefined;
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}
