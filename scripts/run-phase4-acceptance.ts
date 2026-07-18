import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { handleRequestRemoteExecution } from "../application/execution-commands";
import { closeDatabasePool } from "../lib/database";
import { DEFAULT_OWNER_ID } from "../lib/identity-constants";
async function main() {
  const file = process.env.PHASE4_CREDENTIAL_FILE;
  if (!file) throw new Error("PHASE4_CREDENTIAL_FILE is required");
  const fixture = JSON.parse(await readFile(file, "utf8")) as { workspaceId: string; agentId: string; taskId: string };
  const result = await handleRequestRemoteExecution({
    actor: { workspaceId: fixture.workspaceId, id: DEFAULT_OWNER_ID, type: "human" },
    commandId: randomUUID(),
    taskId: fixture.taskId,
    agentId: fixture.agentId,
    timeoutSeconds: 300,
  });
  console.log(JSON.stringify({ event: "phase4_execution_requested", ...result }));
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDatabasePool);
