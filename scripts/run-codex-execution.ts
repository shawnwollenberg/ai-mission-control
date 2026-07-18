import { closeDatabasePool } from "../lib/database";
import { executeCodex } from "../execution/codex-adapter";
const args = process.argv.slice(2);
const value = (flag: string) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const workspaceId = value("--workspace"),
  executionId = value("--execution");
if (!workspaceId || !executionId) throw new Error("--workspace and --execution are required");
executeCodex({ workspaceId, executionId, workerId: process.env.WORKER_ID ?? "codex-cli" })
  .then((result) => console.log(JSON.stringify({ event: "codex_execution_finished", ...result })))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDatabasePool);
