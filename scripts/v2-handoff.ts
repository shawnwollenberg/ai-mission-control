import { readFile } from "node:fs/promises";
import { promoteDirectCodexHandoff, type DirectCodexHandoffInput } from "../v2/handoff/direct-codex-handoff";

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error("Usage: npm run mc:v2:handoff -- /absolute/path/to/handoff.json");
  const input = JSON.parse(await readFile(inputPath, "utf8")) as DirectCodexHandoffInput;
  const result = await promoteDirectCodexHandoff(input);
  console.log(
    JSON.stringify(
      { issueNumber: result.issueNumber, issueUrl: result.issueUrl, state: result.mission.state },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
