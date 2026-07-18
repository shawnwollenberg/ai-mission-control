import { requestSensitiveAction, resolveActionApproval } from "../application/action-commands";
import { executeAction } from "../application/action-executor";
import { DEFAULT_OWNER_ID, DEFAULT_WORKSPACE_ID } from "../lib/identity-constants";
import { closeDatabasePool } from "../lib/database";
const args = process.argv.slice(2),
  value = (flag: string) => args[args.indexOf(flag) + 1];
async function main() {
  const mode = value("--mode"),
    actor = { workspaceId: DEFAULT_WORKSPACE_ID, id: DEFAULT_OWNER_ID, type: "human" as const, role: "owner" as const };
  if (mode === "request-push") {
    console.log(
      JSON.stringify(
        await requestSensitiveAction({
          actor,
          commandId: crypto.randomUUID(),
          executionId: value("--execution"),
          actionType: "repository.push_branch",
          parameters: { remote: "origin", branch: value("--branch"), force: false },
          targetResource: `repository:${value("--repository")}`,
        }),
      ),
    );
    return;
  }
  if (mode === "request-pr") {
    console.log(
      JSON.stringify(
        await requestSensitiveAction({
          actor,
          commandId: crypto.randomUUID(),
          executionId: value("--execution"),
          actionType: "repository.create_pull_request",
          parameters: {
            sourceBranch: value("--branch"),
            targetBranch: "main",
            title: "Phase 3: governed Codex publication",
            description:
              "Real Codex fixture change published through separate Mission Control push and pull-request approvals. No merge or deployment.",
            providerRepository: "shawnwollenberg/ai-mission-control",
          },
          targetResource: `repository:${value("--repository")}`,
        }),
      ),
    );
    return;
  }
  if (mode === "decide") {
    console.log(
      JSON.stringify({
        applied: await resolveActionApproval({
          actor,
          approvalId: value("--approval"),
          granted: value("--decision") === "grant",
          reason: value("--reason"),
        }),
      }),
    );
    return;
  }
  if (mode === "execute") {
    console.log(
      JSON.stringify(await executeAction(DEFAULT_WORKSPACE_ID, value("--action"), "phase3-acceptance-worker")),
    );
    return;
  }
  throw new Error("Unknown --mode");
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDatabasePool);
