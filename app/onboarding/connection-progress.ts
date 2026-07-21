export type ConnectionProgressAgent = {
  mission_agent_version?: string;
  last_heartbeat_at?: string;
  pull_ready_at?: string;
  repository_count?: number;
};

export function connectionProgress(connectionExists: boolean, agent: ConnectionProgressAgent | undefined) {
  return {
    generated: connectionExists,
    installed: Boolean(agent?.mission_agent_version),
    heartbeat: Boolean(agent?.last_heartbeat_at),
    pullReady: Boolean(agent?.pull_ready_at),
    repository: (agent?.repository_count ?? 0) > 0,
  };
}
