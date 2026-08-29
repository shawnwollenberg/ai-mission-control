import { createHash } from "node:crypto";

export function requireWorkerAuthentication(request: Request) {
  const expected = process.env.MISSION_CONTROL_V2_WORKER_TOKEN_SHA256?.trim().toLowerCase();
  if (!expected || !/^[0-9a-f]{64}$/.test(expected)) throw new Error("WORKER_AUTH_NOT_CONFIGURED");
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const actual = createHash("sha256").update(token).digest("hex");
  let mismatch = actual.length ^ expected.length;
  for (let index = 0; index < Math.max(actual.length, expected.length); index++)
    mismatch |= (actual.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  if (mismatch !== 0) throw new Error("WORKER_UNAUTHORIZED");
}
