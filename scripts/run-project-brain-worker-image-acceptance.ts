import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { requestProjectBrainOperation } from "../application/project-brain-commands";
import { closeDatabasePool, getDatabasePool } from "../lib/database";
import { claimJob } from "../lib/job-store";
import { processOneOutbox } from "../lib/outbox-dispatcher";

const repository = resolve(process.env.PROJECT_BRAIN_ACCEPTANCE_REPOSITORY ?? "");
if (!repository || repository === "/")
  throw new Error("PROJECT_BRAIN_ACCEPTANCE_REPOSITORY must be an explicit absolute path");

const command = (args: string[]) => execFileSync("/usr/bin/git", args, { cwd: repository, encoding: "utf8" }).trim();

async function main() {
  await mkdir(repository, { recursive: true });
  command(["init", "-q", "-b", "main"]);
  command(["config", "user.email", "worker-image-acceptance@example.invalid"]);
  command(["config", "user.name", "Worker Image Acceptance"]);
  await writeFile(resolve(repository, "README.md"), "# Disposable worker image acceptance\n");
  command(["add", "README.md"]);
  command(["commit", "-qm", "initial disposable fixture"]);
  const head = command(["rev-parse", "HEAD"]);

  const workspaceId = randomUUID();
  const repositoryId = randomUUID();
  const operationId = randomUUID();
  const actorId = randomUUID();
  await getDatabasePool().query(
    "INSERT INTO workspaces(id,slug,name) VALUES($1,$2,'Project Brain worker image acceptance')",
    [workspaceId, `pb-worker-image-${workspaceId}`],
  );
  await getDatabasePool().query(
    `INSERT INTO repositories(
       workspace_id,repository_id,name,local_path,default_branch,allowed_agent_ids,read_allowed,write_allowed,
       commit_allowed,push_allowed,merge_allowed,deployment_allowed,validation_commands,project_brain_enabled,
       location_mode,observed_commit
     ) VALUES($1,$2,$3,$4,'main','[]',true,false,false,false,false,false,'[]',true,'server',$5)`,
    [workspaceId, repositoryId, basename(repository), repository, head],
  );
  const requested = await requestProjectBrainOperation({
    actor: { workspaceId, id: actorId, type: "human" },
    request: {
      operationId,
      repositoryId,
      operation: "detect_repository",
      startingSha: head,
      idempotencyKey: randomUUID(),
    },
  });
  if (!requested.authorized) throw new Error(`Operation denied: ${requested.reasons.join(",")}`);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await processOneOutbox("project-brain-worker-image-acceptance-outbox");
    const job = await claimJob("deliberately-interrupted-worker", 1, workspaceId, "project_brain_operation");
    if (job) {
      process.stdout.write(`${JSON.stringify({ workspaceId, repositoryId, operationId, jobId: job.jobId, head })}\n`);
      return;
    }
  }
  throw new Error("Project Brain job was not enqueued");
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(closeDatabasePool);
