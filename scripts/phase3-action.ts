import { requestSensitiveAction, resolveActionApproval } from "../application/action-commands";
import { executeAction } from "../application/action-executor";
import { DEFAULT_OWNER_ID, DEFAULT_WORKSPACE_ID } from "../lib/identity-constants";
import { closeDatabasePool } from "../lib/database";
const args = process.argv.slice(2),
  value = (flag: string) => {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
  },
  required = (flag: string) => {
    const result = value(flag);
    if (!result) throw new Error(`${flag} is required`);
    return result;
  };
async function main() {
  const mode = value("--mode"),
    actor = { workspaceId: DEFAULT_WORKSPACE_ID, id: DEFAULT_OWNER_ID, type: "human" as const, role: "owner" as const };
  if (mode === "request-push") {
    console.log(
      JSON.stringify(
        await requestSensitiveAction({
          actor,
          commandId: crypto.randomUUID(),
          executionId: required("--execution"),
          actionType: "repository.push_branch",
          parameters: { remote: "origin", branch: required("--branch"), force: false },
          targetResource: `repository:${required("--repository")}`,
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
          executionId: required("--execution"),
          actionType: "repository.create_pull_request",
          parameters: {
            sourceBranch: required("--branch"),
            targetBranch: value("--target") ?? "main",
            title: value("--title") ?? "Phase 3: governed Codex publication",
            description:
              value("--description") ??
              "Real Codex fixture change published through separate Mission Control push and pull-request approvals. No merge or deployment.",
            providerRepository: value("--provider-repository") ?? "shawnwollenberg/ai-mission-control",
          },
          targetResource: `repository:${required("--repository")}`,
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
          approvalId: required("--approval"),
          granted: value("--decision") === "grant",
          reason: required("--reason"),
        }),
      }),
    );
    return;
  }
  if (mode === "execute") {
    console.log(
      JSON.stringify(await executeAction(DEFAULT_WORKSPACE_ID, required("--action"), "phase3-acceptance-worker")),
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
