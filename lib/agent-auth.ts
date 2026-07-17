export function isAuthorizedAgentRequest(request: Request): boolean {
  const token = process.env.MISSION_CONTROL_AGENT_TOKEN;
  if (!token) return false;
  return request.headers.get("authorization") === `Bearer ${token}`;
}

export function agentAuthError() {
  return process.env.MISSION_CONTROL_AGENT_TOKEN
    ? { error: "Unauthorized", status: 401 }
    : { error: "Agent ingestion is not configured", status: 503 };
}
